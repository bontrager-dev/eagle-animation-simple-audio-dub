import { Client } from '@xhayper/discord-rpc';
import { ActivityType } from 'discord-api-types/v10';

// Registered by Brickfilms.com
const CLIENT_ID = '1496503871919493131';
const RETRY_DELAY = 60000;

// Only connected while the user has the Discord setting on: nothing reaches Discord otherwise
let client = null;
let isReady = false;
let pendingActivity = null;
let retryTimer = null;

const startedAt = new Date();

const connect = () => {
  if (client) {
    return;
  }
  client = new Client({ clientId: CLIENT_ID });
  client.on('ready', () => {
    isReady = true;
    if (pendingActivity) {
      client?.user?.setActivity(pendingActivity);
      pendingActivity = null;
    }
  });

  const attemptLogin = () => {
    client?.login().catch(() => {
      if (client) {
        retryTimer = setTimeout(attemptLogin, RETRY_DELAY);
      }
    });
  };
  attemptLogin();
};

export const setDiscordActivity = (activityInfo) => {
  const activity = {
    ...activityInfo,
    startTimestamp: startedAt,
    type: ActivityType.Playing,
    largeImageKey: 'logo',
  };

  connect();
  if (isReady) {
    client.user?.setActivity(activity);
  } else {
    pendingActivity = activity;
  }
};

export const stopDiscordActivity = () => {
  clearTimeout(retryTimer);
  pendingActivity = null;
  if (!client) {
    return;
  }
  const previousClient = client;
  const wasReady = isReady;
  client = null;
  isReady = false;
  const clearing = wasReady && previousClient.user ? previousClient.user.clearActivity() : Promise.resolve();
  clearing.catch(() => {}).finally(() => previousClient.destroy().catch(() => {}));
};
