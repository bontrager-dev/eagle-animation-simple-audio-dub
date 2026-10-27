import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { PROJECTS_PATH } from '../config';

// Values sent by the renderer become file names, so they must stay one plain path segment
const isSafeName = (name) => typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !/[\\/\0:]/.test(name);

export const assertSafeName = (name, label = 'NAME') => {
  if (!isSafeName(typeof name === 'number' ? `${name}` : name)) {
    throw new Error(`INVALID_${label}`);
  }
  return `${name}`;
};

export const assertExtension = (extension) => {
  if (!/^[a-z0-9]{1,10}$/i.test(`${extension}`)) {
    throw new Error('INVALID_EXTENSION');
  }
  return `${extension}`.toLowerCase();
};

export const assertTrackId = (trackId) => {
  const value = Number(trackId);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('INVALID_TRACK_ID');
  }
  return value;
};

export const assertFrameIndex = (index) => {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('INVALID_FRAME_INDEX');
  }
  return index;
};

export const getProjectPath = (projectId) => join(PROJECTS_PATH, assertSafeName(projectId, 'PROJECT_ID'));

// For paths that arrive in one piece (ea:// URLs): true only if `path` resolves inside `folder`
export const isInsideFolder = (folder, path) => {
  const relativePath = relative(resolve(folder), resolve(path));
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
};
