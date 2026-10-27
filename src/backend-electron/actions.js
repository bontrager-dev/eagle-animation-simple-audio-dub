import { randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';

import { shell } from 'electron';
import { mkdirp } from 'mkdirp';
import { join } from 'path-browserify';

import { getEncodingProfile } from '../common/ffmpeg';
import { CONTRIBUTE_REPOSITORY } from '../config';
import { PROJECTS_PATH } from './config';
import { uploadFile } from './core/api';
import { clearCache, getCacheSize } from './core/cache';
import { setDiscordActivity, stopDiscordActivity } from './core/discord';
import { exportProjectScene, exportSaveTemporaryBuffer, getSyncList, saveSyncList } from './core/export';
import { assertExtension, assertFrameIndex, assertSafeName, assertTrackId, getProjectPath } from './core/paths';
import { createProject, deleteProject, getAudio, getProjectData, getProjectsList, projectSave, saveAudio, savePicture } from './core/projects';
import { getCameraSettings, getSettings, saveCameraSettings, saveSettings } from './core/settings';
import { getToucanCameraServerConfig, setToucanCameraServerConfig, stopToucanCameraServer } from './core/toucan';
import { openWebLink, selectFile, selectFolder } from './core/utils';

console.log(`💾 Eagle Animation files will be saved in the following folder: ${PROJECTS_PATH}`);

const getPictureLink = (projectId, sceneIndex, filename) => `ea://api/pictures/${projectId}/${sceneIndex}/${filename}`;
const getMetaPictureLink = (projectId, sceneIndex, filename) => `ea://api/pictures/${projectId}/${sceneIndex}/${filename}?infos=json`;

const FRAME_TYPES = {
  MASKING_BACKGROUND: '-background',
  MASKING_FOREGROUND: '-foreground',
  MASKING_TRANSPARENT: '-transparent',
  FRAME: '',
};

// Scene number (1-based, deleted scenes are skipped) padded to 4 digits, used as export frame prefix
const getScenePrefix = (scenes, trackId) => `${scenes.slice(0, trackId + 1).filter((scene) => !scene?.deleted).length}`.padStart(4, '0');

const computeProject = (data) => {
  const copiedData = structuredClone(data);
  const scenes = copiedData.project.scenes.map((scene, i) => ({
    ...scene,
    id: scene.id || randomUUID(),
    deleted: scene.deleted || false,
    pictures: scene.pictures.map((picture) => ({
      ...picture,
      link: getPictureLink(copiedData._id, i, picture.filename),
      metaLink: getMetaPictureLink(copiedData._id, i, picture.filename),
      ...(picture?.masking
        ? {
            masking: {
              background: picture?.masking?.background
                ? {
                    ...picture?.masking?.background,
                    link: getPictureLink(copiedData._id, i, picture?.masking?.background?.filename),
                    metaLink: getMetaPictureLink(copiedData._id, i, picture?.masking?.background?.filename),
                  }
                : null,
              foreground: picture?.masking?.foreground
                ? {
                    ...picture?.masking?.foreground,
                    link: getPictureLink(copiedData._id, i, picture?.masking?.foreground?.filename),
                    metaLink: getMetaPictureLink(copiedData._id, i, picture?.masking?.foreground?.filename),
                  }
                : null,
              transparent: picture?.masking?.transparent
                ? {
                    ...picture?.masking?.transparent,
                    link: getPictureLink(copiedData._id, i, picture?.masking?.transparent?.filename),
                    metaLink: getMetaPictureLink(copiedData._id, i, picture?.masking?.transparent?.filename),
                  }
                : null,
            },
          }
        : {}),
    })),
  }));

  let output = {
    ...copiedData,
    id: copiedData._id,
    project: {
      ...copiedData.project,
      scenes,
    },
    _path: undefined,
    _file: undefined,
  };

  delete output._path;
  delete output._file;

  return output;
};

// Exports may only write where the user pointed the save dialog, never a path chosen by the renderer
let selectedExportPath = null;

const actions = {
  GET_LAST_VERSION: async () => {
    if (CONTRIBUTE_REPOSITORY) {
      const res = await fetch(`https://raw.githubusercontent.com/${CONTRIBUTE_REPOSITORY}/master/package.json`).then((res) => res.json());
      return { version: res?.version || null };
    }
    return { version: null };
  },
  GET_PROJECTS: async () => {
    const projects = await getProjectsList(PROJECTS_PATH);
    return projects.map(computeProject);
  },
  NEW_PROJECT: async (evt, { title }) => {
    const settings = await getSettings(PROJECTS_PATH);
    const data = await createProject(PROJECTS_PATH, title, settings.DEFAULT_FPS);
    return computeProject(data);
  },
  GET_PROJECT: async (evt, { project_id }) => {
    const data = await getProjectData(getProjectPath(project_id));
    return computeProject(data);
  },
  DELETE_PROJECT: async (evt, { project_id }) => {
    await deleteProject(getProjectPath(project_id));
    return null;
  },
  SAVE_PROJECT: async (evt, { project_id, data = {} }) => {
    await projectSave(getProjectPath(project_id), data.project, true);
    const updatedData = await getProjectData(getProjectPath(project_id));
    return computeProject(updatedData);
  },
  SAVE_PICTURE: async (evt, { project_id, track_id, buffer, extension = 'dat' }) => {
    const data = await getProjectData(getProjectPath(project_id));
    const picture = await savePicture(getProjectPath(project_id), assertTrackId(track_id), assertExtension(extension), buffer);
    return {
      ...picture,
      link: getPictureLink(data._id, track_id, picture.filename),
      metaLink: getMetaPictureLink(data._id, track_id, picture.filename),
    };
  },
  // Takes are always WAV; the renderer does not get to choose the file type
  SAVE_AUDIO: async (evt, { project_id, track_id, buffer }) => {
    return saveAudio(getProjectPath(project_id), assertTrackId(track_id), 'wav', buffer);
  },
  GET_AUDIO: async (evt, { project_id, track_id, filename }) => {
    if (!/\.wav$/i.test(assertSafeName(filename, 'FILENAME'))) {
      throw new Error('INVALID_FILENAME');
    }
    return getAudio(getProjectPath(project_id), assertTrackId(track_id), filename);
  },
  OPEN_LINK: async (evt, { link }) => {
    openWebLink(link);
    return null;
  },
  GET_SETTINGS: async () => {
    return getSettings(PROJECTS_PATH);
  },
  SAVE_SETTINGS: async (evt, { settings }) => {
    return saveSettings(PROJECTS_PATH, settings);
  },
  GET_CAMERA_SETTINGS: async (evt, { cameraId }) => {
    return getCameraSettings(PROJECTS_PATH, cameraId);
  },
  SAVE_CAMERA_SETTINGS: async (evt, { cameraId, settings }) => {
    return saveCameraSettings(PROJECTS_PATH, cameraId, settings);
  },
  SYNC: async () => {
    let syncList = await getSyncList(PROJECTS_PATH);
    for (let i = 0; i < syncList.length; i++) {
      const syncElement = syncList[i];
      try {
        if (!syncElement.isUploaded) {
          console.log(`☁️ Sync start ${syncElement.publicCode} (${syncElement.apiKey})`);
          await uploadFile({
            sendMethod: syncElement.sendMethod,
            endpoint: syncElement.apiEndpoint,
            apiKey: syncElement.apiKey,
            code: syncElement.publicCode,
            email: syncElement.email,
            fileExtension: syncElement.fileExtension,
            filePath: join(PROJECTS_PATH, '/.sync/', syncElement.fileName),
          });
          syncList[i].isUploaded = true;
          await saveSyncList(PROJECTS_PATH, syncList);
          console.log(`✅ Sync finished ${syncElement.publicCode} (${syncElement.apiKey})`);
        }
      } catch (err) {
        console.log(`❌ Sync failed ${syncElement.publicCode} (${syncElement.apiKey})`, err);
      }
    }
  },
  GET_SYNC_LIST: async () => {
    const syncList = await getSyncList(PROJECTS_PATH);
    return syncList;
  },
  APP_CAPABILITIES: async () => {
    const capabilities = [
      'REMOTE_CAMERAS',
      'EXPORT_VIDEO',
      'EXPORT_FRAMES',
      'BACKGROUND_SYNC',
      'EXPORT_VIDEO_H264',
      'EXPORT_VIDEO_HEVC',
      'EXPORT_VIDEO_PRORES',
      'EXPORT_VIDEO_VP8',
      'EXPORT_VIDEO_VP9',
      'FULLSCREEN',
      'SHORTCUTS',
      'LOCAL_DATA_FOLDER',
      'CLEAR_CACHE',
      'AUDIO_DUBBING',
      'DISCORD',
    ];
    return capabilities;
  },
  GET_DATA_FOLDER: async () => {
    return PROJECTS_PATH;
  },
  OPEN_DATA_FOLDER: async () => {
    await shell.openPath(PROJECTS_PATH);
    return null;
  },
  GET_CACHE_SIZE: async () => {
    return getCacheSize();
  },
  CLEAR_CACHE: async () => {
    return clearCache();
  },
  EXPORT_SELECT_PATH: async (
    evt,
    {
      type = 'FILE',
      format = 'h264',
      translations = {
        EXPORT_FRAMES: '',
        EXPORT_VIDEO: '',
        DEFAULT_FILE_NAME: '',
        EXT_NAME: '',
      },
    }
  ) => {
    selectedExportPath = null;
    if (type === 'FOLDER') {
      selectedExportPath = await selectFolder(translations.EXPORT_FRAMES);
    }
    if (type === 'FILE') {
      const profile = getEncodingProfile(format);
      selectedExportPath = await selectFile(translations.DEFAULT_FILE_NAME, profile.extension, translations.EXPORT_VIDEO, translations.EXT_NAME);
    }
    return selectedExportPath;
  },
  EXPORT_BUFFER: async (evt, { project_id, buffer_id, buffer }) => {
    await exportSaveTemporaryBuffer(getProjectPath(project_id), buffer_id, buffer);
  },
  EXPORT: async (
    evt,
    {
      project_id,
      track_id,
      frames = [],
      mode = 'video',
      format = 'h264',
      custom_output_framerate = false,
      custom_output_framerate_number = 10,
      output_path = null,
      public_code = 'default',
      send_method = 'code',
      event_key = '',
      framerate = 10,
      endpoint = null,
      email = null,
      audio_buffer_id = null,
    },
    sendToRenderer
  ) => {
    if (mode !== 'send' && (!output_path || output_path !== selectedExportPath)) {
      throw new Error('EXPORT_PATH_NOT_SELECTED');
    }
    selectedExportPath = null;

    if (mode === 'frames') {
      if (output_path) {
        const project = await getProjectData(getProjectPath(project_id));
        const scenePrefix = getScenePrefix(project.project.scenes, Number(track_id));
        const bufferDirectoryPath = join(getProjectPath(project_id), `/.tmp/`);
        for (const frame of frames) {
          if (!Object.hasOwn(FRAME_TYPES, frame.type)) {
            throw new Error('INVALID_FRAME_TYPE');
          }
          const fileName = `${scenePrefix}_${assertFrameIndex(frame.index).toString().padStart(6, '0')}${FRAME_TYPES[frame.type]}.${assertExtension(frame.extension)}`;
          await copyFile(join(bufferDirectoryPath, assertSafeName(frame.buffer_id, 'BUFFER_ID')), join(output_path, fileName));
        }
      }
      return true;
    }

    const profile = getEncodingProfile(format);

    // Create sync folder if needed
    if (mode === 'send') {
      await mkdirp(join(PROJECTS_PATH, '/.sync/'));
    }

    const fileId = randomUUID();
    const path = mode === 'send' ? join(PROJECTS_PATH, '/.sync/', `${fileId}.${profile.extension}`) : output_path;
    await exportProjectScene(
      getProjectPath(project_id),
      track_id,
      frames,
      path,
      format,
      {
        customOutputFramerate: custom_output_framerate,
        customOutputFramerateNumber: custom_output_framerate_number,
        framerate: Number(framerate),
        audioBufferId: audio_buffer_id,
      },
      (progress) => sendToRenderer('FFMPEG_PROGRESS', { progress })
    );

    if (mode === 'send' && endpoint) {
      const syncList = await getSyncList(PROJECTS_PATH);
      await saveSyncList(PROJECTS_PATH, [
        ...syncList,
        {
          sendMethod: send_method,
          apiKey: event_key,
          publicCode: send_method === 'code' ? public_code : null,
          email: send_method === 'email' ? email : null,
          fileName: `${fileId}.${profile.extension}`,
          fileExtension: profile.extension,
          isUploaded: false,
          apiEndpoint: endpoint,
        },
      ]);

      actions.SYNC();
    }

    return true;
  },
  DISCORD_ACTIVITY: async (evt, { enabled = false, description, actionIcon, actionTitle, applicationTitle }) => {
    if (!enabled) {
      stopDiscordActivity();
      return;
    }
    setDiscordActivity({
      details: description || null,
      smallImageKey: actionIcon || null,
      smallImageText: actionTitle || null,
      largeImageText: applicationTitle || null,
    });
  },
  TOUCAN_CAMERA_SERVER_GET_CONFIG: async () => {
    return getToucanCameraServerConfig();
  },
  TOUCAN_CAMERA_SERVER_SET_CONFIG: async (evt, { expose = false, token = null } = {}) => {
    return setToucanCameraServerConfig({ expose, token });
  },
  TOUCAN_CAMERA_SERVER_STOP: async () => {
    return stopToucanCameraServer();
  },
};

export default actions;
