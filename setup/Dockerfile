FROM ubuntu:24.04

ARG USERNAME=ubuntu
ARG USER_UID=1000
ARG USER_GID=1000

ENV USERNAME=${USERNAME}

RUN apt-get update && apt-get install -y \
    curl \
    wget \
    sudo \
    git \
    ripgrep \
    sqlite3 \
    nano \
    openssh-server \
    jq \
    ca-certificates \
    unzip \
    apt-transport-https \
    gnupg \
    lsof \
    bubblewrap

RUN groupadd --gid ${USER_GID} ${USERNAME} 2>/dev/null || groupmod -n ${USERNAME} $(getent group ${USER_GID} | cut -d: -f1) || true \
    && useradd --uid ${USER_UID} --gid ${USER_GID} -m ${USERNAME} -s /bin/bash 2>/dev/null || usermod -l ${USERNAME} -d /home/${USERNAME} -m $(getent passwd ${USER_UID} | cut -d: -f1) || true \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/${USERNAME} \
    && chmod 0440 /etc/sudoers.d/${USERNAME}

RUN mkdir -p /run/sshd \
    && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/#AuthorizedKeysFile/AuthorizedKeysFile/' /etc/ssh/sshd_config \
    && echo "HostKey /etc/ssh/host_keys/ssh_host_rsa_key" >> /etc/ssh/sshd_config \
    && echo "HostKey /etc/ssh/host_keys/ssh_host_ed25519_key" >> /etc/ssh/sshd_config

# Install GitHub CLI
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && cat $out | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && mkdir -p -m 755 /etc/apt/sources.list.d \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install gh -y

# Install ffmpeg
RUN apt-get install -y ffmpeg

# Install yt-dlp
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/bin/yt-dlp && \
    chmod a+x /usr/bin/yt-dlp

# Switch to user for user-specific installations
USER ${USERNAME}
WORKDIR /home/${USERNAME}

RUN touch /home/${USERNAME}/.sudo_as_admin_successful

# Overwrite .bashrc
RUN cat << 'EOF' > /home/${USERNAME}/.bashrc
PS1='\h \W \$ '
EOF

# Install NVM, Node.js LTS, and Yarn
ENV NVM_DIR=/home/${USERNAME}/.nvm
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash \
    && . ${NVM_DIR}/nvm.sh \
    && nvm install --lts \
    && nvm use --lts \
    && npm install -g yarn

# Install Bun
ENV BUN_INSTALL=/home/${USERNAME}/.bun
RUN curl -fsSL https://bun.sh/install | bash

# Install code-server
RUN mkdir -p /home/${USERNAME}/.local/share/code-server
RUN curl -fsSL https://code-server.dev/install.sh | sh

# Install OpenCode
RUN curl -fsSL https://opencode.ai/install | bash

# Install workspace CLI
RUN curl -fsSL https://static.fastly.carvanatech.com/workspace-cli/install.sh | bash

# Install Chromium for headless browser Chrome DevTools MCP
RUN . ${NVM_DIR}/nvm.sh \
    && npx -y playwright@1.61.1 install --with-deps chromium

USER root

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
EXPOSE 8080
EXPOSE 4096

ENTRYPOINT ["/entrypoint.sh"]
