FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY data/bin/code-server-go /usr/local/bin/code-server-go

RUN printf 'hello from ubuntu\n' > /workspace/notes.txt

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/code-server-go"]
