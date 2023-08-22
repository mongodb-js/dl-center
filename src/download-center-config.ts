/* AUTO-GENERATED DO NOT EDIT. */

export type DownloadCenterConfig = DownloadCenterConfigV1 | DownloadCenterConfigV2;

export interface DownloadCenterConfigV1 {
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
export interface DownloadCenterConfigV2 {
  previous_releases_link: string;
  release_notes_link: string;
  tutorial_link: string;
  version: string;
  manual_link: string;
  platform: Platform[];
}
export interface Platform {
  arch: string;
  os: string;
  packages: Package;
}
export interface Package {
  title: string;
  links: Link[];
}
export interface Link {
  download_link: string;
  name: string;
}
