ARG UBUNTU_IMAGE=docker.io/library/ubuntu:24.04
ARG NODE_VERSION=22.22.1
ARG GO_VERSION=1.26.1
ARG PLAYWRIGHT_VERSION=1.52.0
ARG ELECTRON_VERSION=39.8.7
ARG VSCODE_REPO_URL=https://github.com/microsoft/vscode
ARG VSCODE_COMMIT=50f36fc4ffa240e366be854f001d3f1f7461b0bd

FROM ${UBUNTU_IMAGE} AS node-toolchain

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_VERSION

RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates \
	curl \
	xz-utils \
	&& rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/node \
	&& curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
	| tar -xJ --strip-components=1 -C /opt/node

FROM ${UBUNTU_IMAGE} AS go-toolchain

ARG DEBIAN_FRONTEND=noninteractive
ARG GO_VERSION

RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates \
	curl \
	&& rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/go \
	&& curl -fsSL "https://dl.google.com/go/go${GO_VERSION}.linux-amd64.tar.gz" \
	| tar -xzf - --strip-components=1 -C /opt/go

FROM ${UBUNTU_IMAGE} AS vscode-source

ARG DEBIAN_FRONTEND=noninteractive
ARG VSCODE_REPO_URL
ARG VSCODE_COMMIT

RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates \
	curl \
	g++ \
	git \
	libkrb5-dev \
	libsecret-1-dev \
	libx11-dev \
	libxkbfile-dev \
	make \
	patch \
	pkg-config \
	python3 \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=node-toolchain /opt/node /opt/node

ENV PATH=/opt/node/bin:${PATH}

WORKDIR /opt/vscode

# 分开 clone 和 checkout，这样调整固定 commit 时仍可复用 clone 层。
RUN git clone "${VSCODE_REPO_URL}" .
RUN git checkout --detach "${VSCODE_COMMIT}"

FROM vscode-source AS vscode-deps

# 将依赖安装放在独立阶段，避免应用源码变化导致依赖层失效。
ARG ELECTRON_VERSION
ENV npm_config_runtime=electron
ENV npm_config_target=${ELECTRON_VERSION}
ENV npm_config_disturl=https://artifacts.electronjs.org/headers/dist
ENV npm_config_build_from_source=true
RUN mkdir -p "/root/.cache/node-gyp/${ELECTRON_VERSION}" \
	&& curl --retry 10 --retry-all-errors --retry-delay 5 --connect-timeout 30 --max-time 600 -fsSL \
	"https://artifacts.electronjs.org/headers/dist/v${ELECTRON_VERSION}/node-v${ELECTRON_VERSION}-headers.tar.gz" \
	| tar -xzf - --strip-components=1 -C "/root/.cache/node-gyp/${ELECTRON_VERSION}" \
	&& printf '11\n' > "/root/.cache/node-gyp/${ELECTRON_VERSION}/installVersion" \
	&& patch -p0 -i /opt/vscode/build/npm/gyp/custom-headers/v8-source-location.patch \
		-d "/root/.cache/node-gyp/${ELECTRON_VERSION}/include/node"
RUN npm ci

FROM vscode-deps AS vscode-build

RUN npm run gulp compile-client \
	&& test -d out \
	&& test -f out/vs/code/browser/workbench/callback.html

FROM ${UBUNTU_IMAGE} AS go-deps

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates \
	git \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=go-toolchain /opt/go /opt/go

ENV PATH=/opt/go/bin:${PATH}

WORKDIR /src/project

COPY go.mod go.sum ./
RUN go mod download

COPY scripts/go-script/go.mod scripts/go-script/go.sum ./scripts/go-script/
RUN cd scripts/go-script && go mod download

FROM go-deps AS app-build

WORKDIR /src/project

COPY cmd ./cmd
COPY internal ./internal
COPY web ./web
COPY distfs.go ./
COPY scripts/go-script ./scripts/go-script

# 构建脚本通过 .git 判断仓库根目录，这里创建一个轻量本地仓库。
RUN git init -q .

COPY --from=vscode-build /opt/vscode/out /opt/vscode/out
COPY --from=vscode-build /opt/vscode/resources /opt/vscode/resources
COPY --from=vscode-build /opt/vscode/node_modules/@xterm /opt/vscode/node_modules/@xterm
COPY --from=vscode-build /opt/vscode/node_modules/@vscode/codicons /opt/vscode/node_modules/@vscode/codicons

ENV VSCODE_REPO_ROOT=/opt/vscode

RUN cd scripts/go-script && go run . build

FROM ${UBUNTU_IMAGE} AS runtime

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY --from=app-build /src/project/data/bin/code-server-go /usr/local/bin/code-server-go

EXPOSE 8080
STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/local/bin/code-server-go"]

FROM ${UBUNTU_IMAGE} AS e2e-runner

ARG DEBIAN_FRONTEND=noninteractive
ARG PLAYWRIGHT_VERSION

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=node-toolchain /opt/node /opt/node

ENV PATH=/opt/node/bin:${PATH}

WORKDIR /opt/e2e

RUN printf '{\n  "name": "vscgo-e2e-runner",\n  "private": true,\n  "dependencies": {\n    "playwright": "%s"\n  }\n}\n' "${PLAYWRIGHT_VERSION}" > package.json
RUN npm install
RUN npx playwright install --with-deps chromium

COPY scripts/playwright ./scripts/playwright

ENTRYPOINT ["node", "/opt/e2e/scripts/playwright/e2e.mjs"]
