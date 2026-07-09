FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN apk add --no-cache docker-cli && npm install --production

COPY src/ ./src/

ENV NODE_ENV=production

# The bot will be configured to run with `node src/index.js`
CMD ["node", "src/index.js"]
