FROM node:slim AS development

RUN apt-get update && apt-get install -y procps openssl

WORKDIR /usr/src/app

COPY --chown=node:node package.json yarn.lock ./

RUN yarn agmod-mmr-install-dev

COPY --chown=node:node . .

USER node

FROM node:slim AS build

WORKDIR /usr/src/app

COPY --chown=node:node package.json yarn.lock ./
COPY --chown=node:node --from=development /usr/src/app/node_modules ./node_modules
COPY --chown=node:node . .

RUN yarn agmod-mmr-build

ENV NODE_ENV production
RUN yarn agmod-mmr-install-prod

USER node

FROM node:slim AS production

COPY --chown=node:node --from=build /usr/src/app/node_modules ./node_modules
COPY --chown=node:node --from=build /usr/src/app/dist ./dist
COPY --chown=node:node --from=build /usr/src/app/scripts/*.sh ./scripts/

USER node

# TODO: Workaround for migrations, not ideal for production but it works
RUN yarn global add @nestjs/cli