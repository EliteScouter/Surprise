FROM nginxinc/nginx-unprivileged:1.27-alpine
USER root
RUN apk upgrade --no-cache && rm -f /etc/nginx/conf.d/default.conf
COPY gate/default.conf.template /etc/nginx/templates/default.conf.template
COPY gate/proxy_headers.conf /etc/nginx/proxy_headers.conf
USER 101
ENV GATE_ALLOW=all NPM_PROXY=10.0.101.1
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
