FROM node:lts-alpine as build
WORKDIR /app

COPY /tsconfig.json ./
COPY /package.json ./
COPY /package-lock.json ./
RUN npm install

COPY /src ./src
RUN npm run compile

FROM node:lts-alpine

EXPOSE 3000
EXPOSE 8080

WORKDIR /app
COPY /package.json ./
COPY --from=build /app/dist ./dist

RUN npm install --omit=dev

CMD ["npm", "run", "start"]