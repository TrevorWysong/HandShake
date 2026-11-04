# The network's bootstrap/relay server (`kitsune2-bootstrap-srv`): how
# everyone's node finds the others. It holds nothing of anyone's.
# Build from the repo root: docker build -f deploy/bootstrap/Dockerfile .
FROM debian:bookworm-slim

# Holochain's official Linux binary, pinned and checked -- the same release
# and hash as CI (.github/actions/holochain-bins/action.yml).
ARG RELEASE=holochain-0.7.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && cd /usr/local/bin \
 && curl -fsSL "https://github.com/holochain/holochain/releases/download/${RELEASE}/kitsune2-bootstrap-srv-x86_64-unknown-linux-gnu" -o kitsune2-bootstrap-srv \
 && echo "f080b3ee4f3d4e37a2d790eb3df9722b5b1a1924d9d6c730c05c64859273a9d5  kitsune2-bootstrap-srv" | sha256sum --check --strict \
 && chmod +x kitsune2-bootstrap-srv

EXPOSE 8888
ENTRYPOINT ["kitsune2-bootstrap-srv", "--listen", "0.0.0.0:8888"]
