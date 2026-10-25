ARG NODE_IMAGE=node:22.18.0-alpine@sha256:1b2479dd35a99687d6638f5976fd235e26c5b37e8122f786fcd5fe231d63de5b
FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY /tsconfig.json ./
COPY /package.json ./
COPY /package-lock.json ./
RUN npm ci
COPY /build.mjs ./

COPY /src ./src
RUN npm run build

FROM ${NODE_IMAGE}

EXPOSE 3000
EXPOSE 8080

WORKDIR /app
COPY /package.json ./
COPY --from=build /app/dist ./dist

CMD ["npm", "run", "start"]
