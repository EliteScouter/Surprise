FROM nginxinc/nginx-unprivileged:1.31-alpine
USER root
RUN apk upgrade --no-cache && rm -f /etc/nginx/conf.d/default.conf
COPY gate/nginx.conf /etc/nginx/nginx.conf
COPY gate/default.conf.template /etc/nginx/templates/default.conf.template
COPY gate/db.conf.template /etc/nginx/templates/db.conf.stream-template
COPY gate/egress.conf.template /etc/nginx/templates/egress.conf.stream-template
COPY gate/proxy_headers.conf /etc/nginx/proxy_headers.conf
USER 101
ENV GATE_ALLOW=all NPM_PROXY=10.0.101.1 DB_UPSTREAM=10.10.20.120:3306
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
