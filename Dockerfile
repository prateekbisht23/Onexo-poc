FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git unzip ripgrep procps \
    && rm -rf /var/lib/apt/lists/*

# Replace the default ubuntu (uid 1000) user with onexo so bind mounts map cleanly
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -u 1000 -s /bin/bash onexo

USER onexo
ENV HOME=/home/onexo
ENV PATH="/home/onexo/.local/bin:${PATH}"

# Claude Code (native installer, lands in ~/.local/bin)
RUN curl -fsSL https://claude.ai/install.sh | bash

WORKDIR /home/onexo/projects

# The container is just a Claude runtime: the host backend drives it via
# `docker exec claude-poc claude -p ...`, so it only needs to stay alive.
CMD ["sleep", "infinity"]
