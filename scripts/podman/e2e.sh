#!/usr/bin/env sh
set -eu

root_dir=${ROOT_DIR:?ROOT_DIR is required}
image_name=${IMAGE_NAME:?IMAGE_NAME is required}
e2e_image_name=${E2E_IMAGE_NAME:?E2E_IMAGE_NAME is required}

timestamp=$(date +%Y%m%d-%H%M%S)
run_dir="${root_dir}/data/e2e/runs/${timestamp}"
output_dir="${run_dir}/local"
workspace_dir="${output_dir}/workspace"
workspace_file="${workspace_dir}/playground.txt"
server_log_path="${output_dir}/server.log"
result_json_path="${output_dir}/result.json"
report_path="${run_dir}/report.md"
app_container="vscgo-e2e-app-${timestamp}"

mkdir -p "${workspace_dir}"
printf 'original from e2e\n' > "${workspace_file}"

cleanup() {
	podman logs "${app_container}" >"${server_log_path}" 2>&1 || true
	podman rm -f "${app_container}" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

podman build --layers --target runtime -t "${image_name}" "${root_dir}"
podman build --layers --target e2e-runner -t "${e2e_image_name}" "${root_dir}"

podman run -d --rm \
	--name "${app_container}" \
	-v "${workspace_dir}:/workspace" \
	-w /workspace \
	"${image_name}" >/dev/null

# 等待容器网络命名空间就绪，再让 runner 加入。
sleep 2

set +e
overall_status=0
for scenario in local-dev-flow builtin-extensions open-folder-ui; do
	scenario_output_dir="${output_dir}/${scenario}"
	mkdir -p "${scenario_output_dir}"

	runner_output=$(
		podman run --rm \
			--network "container:${app_container}" \
			-v "${scenario_output_dir}:/output" \
			-v "${workspace_dir}:/workspace" \
			"${e2e_image_name}" \
			--url "http://127.0.0.1:8080" \
			--scenario "${scenario}" \
			--output-dir /output \
			--workspace-file /workspace/playground.txt
	)
	scenario_status=$?

	printf '%s\n' "${runner_output}" > "${scenario_output_dir}/result.json"

	if [ "${scenario_status}" -ne 0 ]; then
		overall_status=1
	fi
done
runner_status=${overall_status}
set -e

printf '%s\n' "${runner_output}" > "${result_json_path}"
podman logs "${app_container}" >"${server_log_path}" 2>&1 || true

node - "${result_json_path}" "${report_path}" "${server_log_path}" "${run_dir}" "${output_dir}" <<'EOF'
const fs = require('fs');
const path = require('path');

const [, , resultPath, reportPath, serverLogPath, runDir, outputDir] = process.argv;
const raw = fs.readFileSync(resultPath, 'utf8').trim();

let result;
try {
	result = JSON.parse(raw);
} catch (error) {
	result = {
		scenario: 'container-dev-flow',
		status: 'failed',
		url: '',
		screenshots: [],
		observations: [`无法解析 runner 输出：${error.message}`, raw],
	};
}

const lines = [
	'# code-server-go E2E 报告',
	'',
	'流程：从根目录 Dockerfile 构建运行镜像 -> 使用临时工作区启动 app 容器 -> 在独立容器中运行 Playwright 场景 -> 采集截图和日志。',
	'',
	`- 运行目录：\`${runDir}\``,
	`- 状态：**${result.status || 'failed'}**`,
];

if (result.url) {
	lines.push(`- URL: \`${result.url}\``);
}

const observations = Array.isArray(result.observations) ? result.observations.slice() : [];
observations.push(`服务端日志：${serverLogPath}`);
for (const note of observations) {
	lines.push(`- 观察：${note}`);
}

for (const shot of Array.isArray(result.screenshots) ? result.screenshots : []) {
	const hostShot = path.isAbsolute(shot) && shot.startsWith('/output/')
		? path.join(outputDir, path.relative('/output', shot))
		: shot;
	const rel = path.relative(runDir, hostShot);
	lines.push(`- 截图：\`${rel}\``);
}

lines.push('');
fs.writeFileSync(reportPath, `${lines.join('\n')}\n`);
EOF

printf 'e2e 报告：%s\n' "${report_path}"

if [ "${runner_status}" -ne 0 ]; then
	exit "${runner_status}"
fi
