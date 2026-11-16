# Keep build and runtime libc/Node versions identical.
ARG NODE_IMAGE=node:24.22.1-alpine
FROM ${NODE_IMAGE} AS hardened-malloc
# Pin allocator source instead of building a moving branch.
ARG HARDENED_MALLOC_REV=bf37d54560a62b50da72e8fda56abf04f23b5fd2
RUN apk add --no-cache git build-base linux-headers
WORKDIR /hardened_malloc
RUN git init . \
    && git remote add origin https://github.com/GrapheneOS/hardened_malloc.git \
    && git fetch --depth 1 origin "${HARDENED_MALLOC_REV}" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${HARDENED_MALLOC_REV}" \
    && make -j2 CONFIG_NATIVE=false CONFIG_CXX_ALLOCATOR=false

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && npm cache clean --force

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF

# Install before enabling LD_PRELOAD. No compiler or git enters the final image.
RUN apk add --no-cache tzdata tini \
    && cp /usr/share/zoneinfo/Asia/Seoul /etc/localtime \
    && echo 'Asia/Seoul' > /etc/timezone
COPY --from=hardened-malloc /hardened_malloc/out/libhardened_malloc.so /usr/local/lib/libhardened_malloc.so
ENV NODE_ENV=production \
    TZ=Asia/Seoul \
    LD_PRELOAD=/usr/local/lib/libhardened_malloc.so

# Application code remains root-owned and is not writable by the runtime user.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Remove privilege bits across the entire image, including /sbin and libraries.
# Do not hide failures: image creation must fail if this cannot be enforced.
RUN find / -xdev -type f \( -perm /4000 -o -perm /2000 \) -exec chmod a-s {} + \
    && test -z "$(find / -xdev -type f \( -perm /4000 -o -perm /2000 \) -print)" \
    && rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && node -e "if (!require('fs').readFileSync('/proc/self/maps','utf8').includes('libhardened_malloc.so')) process.exit(1)"

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health/liveness',r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main"]
