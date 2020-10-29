/* eslint-disable */
/* AUTO-GENERATED DO NOT EDIT. */

export interface DownloadCenterConfig {
  versions: {
    _id: string;
    version: string;
    platform: {
      arch: string;
      os: string;
      name: string;
      download_link: string;
    }[];
  }[];
  manual_link: string;
  release_notes_link: string;
  previous_releases_link: string;
  development_releases_link: string;
  supported_browsers_link: string;
  tutorial_link: string;
}
