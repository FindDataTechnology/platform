# fd-health-config MCP shim — node_modules are pre-installed (offline build).
FROM public.ecr.aws/docker/library/node:22-slim
WORKDIR /app
COPY package.json ./
COPY node_modules ./node_modules
COPY server.mjs ./
EXPOSE 8090
CMD ["node", "server.mjs"]