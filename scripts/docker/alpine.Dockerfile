FROM alpine:3.22

RUN apk add --no-cache ca-certificates

WORKDIR /workspace

COPY data/bin/code-server-go /usr/local/bin/code-server-go

RUN printf 'hello from alpine\n' > /workspace/notes.txt

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/code-server-go"]
