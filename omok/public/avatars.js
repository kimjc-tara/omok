import { findProfile } from './profiles.js';

export function avatarImage(profileId) {
  const preset = findProfile(profileId);
  if (!preset) return '';
  return `<img class="pixel-avatar" src="/assets/avatars/${preset.avatar}.png" alt="" width="128" height="128" draggable="false" decoding="async">`;
}
