FROM nginx:1.27-alpine
RUN apk add --no-cache ca-certificates
ENV AETHER_SERVER=vpn.geldesat.com
COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY index.html /usr/share/nginx/html/index.html
EXPOSE 80
