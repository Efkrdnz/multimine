import type { PluginPermission } from './types'

/** What each permission means, in the words the consent dialog uses. */
export const PERMISSION_TEXT: Record<PluginPermission, string> = {
  'team:read': 'See your chats (names and models)',
  'agents:message': 'Send messages to your chats, or start a new one',
  'project:read': 'Read files in the open project',
  'project:write': 'Create and change files in the open project',
  'media:read': 'See the media gallery',
  'media:write': 'Add images, video and 3D models to the media gallery',
  network: 'Connect to the internet'
}
