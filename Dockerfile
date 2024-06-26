FROM node:lts-alpine AS build
WORKDIR /app

COPY /tsconfig.json ./
COPY /package.json ./
COPY /package-lock.json ./
RUN npm install
COPY /build.mjs ./

COPY /src ./src
RUN npm run build

FROM node:lts-alpine

EXPOSE 3000
EXPOSE 8080

WORKDIR /app
COPY /package.json ./
COPY --from=build /app/dist ./dist

CMD ["npm", "run", "start"]
