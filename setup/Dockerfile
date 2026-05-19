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
    nano \
    openssh-server \
    jq \
    ca-certificates \
    unzip \
    apt-transport-https \
    gnupg \
    lsof

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

# Install .NET
RUN apt-get install -y dotnet-sdk-8.0 dotnet-sdk-10.0

# Install Azure CLI
RUN curl -sL https://aka.ms/InstallAzureCLIDeb | bash

# Install Google Cloud SDK
RUN echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee -a /etc/apt/sources.list.d/google-cloud-sdk.list \
    && curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && apt-get update \
    && apt-get install -y google-cloud-cli

# Switch to user for user-specific installations
USER ${USERNAME}
WORKDIR /home/${USERNAME}

RUN touch /home/${USERNAME}/.sudo_as_admin_successful

# Overwrite .bashrc
RUN cat << 'EOF' > /home/${USERNAME}/.bashrc
PS1='\h \W \$ '
export PATH="$HOME/projects/TrevorSharp/CustomGitCommands/scripts:$PATH"
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

# Install OpenCode
RUN curl -fsSL https://opencode.ai/install | bash

# Install CSharpier globally
RUN dotnet tool install csharpier --global --version 1.1.1

# Install Claude Code
# RUN curl -fsSL https://claude.ai/install.sh | bash \
#     && echo "export CLAUDE_CODE_USE_VERTEX=1" >> /home/${USERNAME}/.bashrc \
#     && echo "export CLOUD_ML_REGION=us-east5" >> /home/${USERNAME}/.bashrc \
#     && echo "export ANTHROPIC_VERTEX_PROJECT_ID=crv-engineering-ai-prd-8058" >> /home/${USERNAME}/.bashrc

USER root

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
EXPOSE 4096

ENTRYPOINT ["/entrypoint.sh"]
