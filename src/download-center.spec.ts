import fs, { mkdirp } from 'fs-extra';
import path from 'path';
import os from 'os';
import execa from 'execa';
import nock from 'nock';
import expect from 'expect';

import {
  DownloadCenter,
  probePlatformDownloadLink,
  S3BucketConfig,
  validateConfigSchema,
  validateDownloadLinks
} from './download-center';
import { DownloadCenterConfigV2 } from './download-center-config';

describe('download center client', () => {
  let containerId: string;
  let tempDir: string;

  let bucketConfig: S3BucketConfig;
  let downloadCenter: DownloadCenter;

  before(async() => {
    tempDir = await fs.mkdtemp(
      path.join('', 'download-center-tests-'));

    const key = 'AKIAIOSFODNN7EXAMPLE';
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

    const { stdout: dockerRunStdout } = await execa('docker', [
      'run',
      '--rm',
      '-d',
      '-P',
      '-e', `MINIO_ACCESS_KEY=${key}`,
      '-e', `MINIO_SECRET_KEY=${secret}`,
      '-v', `${tempDir}:/data`,
      'minio/minio:edge',
      'server', '/data'
    ]);

    containerId = dockerRunStdout;

    const { stdout: endpoint } = await execa('docker', [
      'port', containerId, '9000/tcp'
    ]);

    bucketConfig = {
      bucket: 'test',
      accessKeyId: key,
      secretAccessKey: secret,
      endpoint,
      sslEnabled: false,
      s3ForcePathStyle: true
    };
  });

  beforeEach(async() => {
    bucketConfig.bucket = `test-${Date.now()}`;
    await fs.mkdir(path.resolve(tempDir, bucketConfig.bucket));
    downloadCenter = new DownloadCenter({ ...bucketConfig });
  });

  after(async() => {
    await execa('docker', ['stop', containerId]);
    await fs.remove(tempDir);
  });

  const fixturePath = (...args: string[]) => path.resolve(
    __dirname, '..', 'fixtures', ...args);

  const bucketPath = (...args: string[]) => path.resolve(
    tempDir, bucketConfig.bucket, ...args);

  describe('uploadAsset', () => {
    it('uploads a file', async() => {
      await downloadCenter.uploadAsset(
        'prefix/asset.txt',
        fs.createReadStream(fixturePath('asset.txt'))
      );

      const content = await fs.readFile(
        bucketPath('prefix', 'asset.txt'), 'utf-8');

      expect(content).toEqual('content\n');
    });
  });

  describe('downloadAsset', () => {
    it('downloads a file', async() => {
      await mkdirp(bucketPath('prefix'));
      await fs.copyFile(
        fixturePath('asset.txt'),
        bucketPath('prefix', 'asset.txt')
      );

      const content = await downloadCenter.downloadAsset(
        'prefix/asset.txt'
      );
      expect(content?.toString()).toEqual('content\n');
    });
  });

  describe('downloadConfig', () => {
    it('downloads an existing config file', async() => {
      await mkdirp(bucketPath('prefix'));
      await fs.copyFile(
        fixturePath('compass.json'),
        bucketPath('prefix', 'compass.json')
      );

      const config = await downloadCenter.downloadConfig('prefix/compass.json');
      expect(config).toHaveProperty('manual_link');
    });
  });

  describe('uploadConfig', () => {
    it('uploads valid configuration', async() => {
      const validConfig = await fs.readJSON(fixturePath('compass.json'));

      await downloadCenter.uploadConfig('prefix/compass.json', validConfig);

      const uploadedConfig = await fs.readJSON(
        bucketPath('prefix', 'compass.json'));

      expect(uploadedConfig).toEqual(validConfig);
    });

    it('rejects an invalid configuration (malformed)', async() => {
      const invalidConfig = {
        ...(await fs.readJSON(fixturePath('compass.json'))),
        versions: null
      };

      const error = await downloadCenter.uploadConfig(
        'prefix/compass.json', invalidConfig).catch((e) => e);

      expect(error.message).toContain(
        'Invalid configuration: data.versions should be array');
    });

    it('rejects an invalid configuration (missing link)', async() => {
      const invalidConfig = {
        ...(await fs.readJSON(fixturePath('compass.json'))),
        versions: [
          {
            '_id': '1.21.2',
            'version': '1.21.2 (Stable)',
            'platform': [
              {
                'arch': 'x64',
                'os': 'darwin',
                'name': 'OS X 64-bit (10.10+)',
                'download_link': 'http://example.com/non-existing-url'
              }
            ]
          }
        ]
      };

      const error = await downloadCenter.uploadConfig(
        'prefix/compass.json', invalidConfig).catch((e) => e);

      expect(error.message).toEqual(
        'Download center urls broken:\n' +
          '- http://example.com/non-existing-url -> 404'
      );
    });
  });

  describe('validate-config v1', () => {
    const links = {
      darwin: 'https://downloads.mongodb.com/compass/mongosh-0.2.2-darwin.zip',
      win32: 'https://downloads.mongodb.com/compass/mongosh-0.2.2-win32.zip',
      linux: 'https://downloads.mongodb.com/compass/mongosh-0.2.2-linux.tgz',
      debian: 'https://downloads.mongodb.com/compass/mongosh_0.2.2_amd64.deb'
    };

    const downloadCenterJson = {
      'versions': [
        {
          '_id': '0.2.2',
          'version': '0.2.2',
          'platform': [
            {
              'arch': 'x64',
              'os': 'darwin',
              'name': 'MacOS 64-bit (10.10+)',
              'download_link': links.darwin
            },
            {
              'arch': 'x64',
              'os': 'win32',
              'name': 'Windows 64-bit (7+)',
              'download_link': links.win32
            },
            {
              'arch': 'x64',
              'os': 'linux',
              'name': 'Linux 64-bit',
              'download_link': links.linux
            },
            {
              'arch': 'x64',
              'os': 'debian',
              'name': 'Debian 64-bit',
              'download_link': links.debian
            }
          ]
        }
      ],
      'manual_link': 'https://docs.mongodb.org/manual/products/mongosh',
      'release_notes_link': 'https://github.com/mongodb-js/mongosh/releases/tag/v0.2.2',
      'previous_releases_link': '',
      'development_releases_link': '',
      'supported_browsers_link': '',
      'tutorial_link': 'test'
    };

    describe('validateConfigSchema', () => {
      it('does not throw with a valid config', () => {
        expect(() => {
          validateConfigSchema(downloadCenterJson);
        }).not.toThrow();
      });

      it('throws with a valid config', () => {
        const invalidConfig = { ...downloadCenterJson, manual_link: undefined };

        expect(() => {
          validateConfigSchema(invalidConfig as any);
        }).toThrowError('Invalid configuration: data should have' +
         ' required property \'manual_link\'');
      });
    });

    describe('validateConfigUrls', () => {
      function nockLink(link: string, status: number, headers = {}): void {
        const url = new URL(link);
        nock(url.origin).head(url.pathname).reply(status, undefined, headers);
      }

      describe('when all links are correct', () => {
        beforeEach(() => {
          nock.cleanAll();
          nockLink(links.darwin, 302, { 'Location': 'http://example.com/redirect' });
          nockLink(links.win32, 200);
          nockLink(links.linux, 200);
          nockLink(links.debian, 200);
          nockLink('http://example.com/redirect', 200);
        });

        afterEach(() => {
          if (!nock.isDone()) {
            throw new Error('HTTP calls to link urls were not done');
          }
        });

        it('does not throw if all the downloads are ok', async() => {
          await expect(validateDownloadLinks(downloadCenterJson))
            .resolves.toBeUndefined();
        });
      });

      describe('with broken links', () => {
        beforeEach(() => {
          nock.cleanAll();
          nockLink(links.darwin, 200);
          nockLink(links.win32, 302, { 'Location': 'http://example.com/redirect' });
          nockLink(links.linux, 200);
          nockLink(links.debian, 404);
          nockLink('http://example.com/redirect', 404);
        });

        afterEach(() => {
          if (!nock.isDone()) {
            throw new Error('HTTP calls to link urls were not done');
          }
        });

        it('throws reporting broken urls', async() => {
          const error = await (
            validateDownloadLinks(downloadCenterJson).catch((e) => e)
          );

          expect(error).not.toBeUndefined();
          expect(error.message).toEqual(
            'Download center urls broken:\n' +
              '- https://downloads.mongodb.com/compass/mongosh-0.2.2-win32.zip -> 404\n' +
              '- https://downloads.mongodb.com/compass/mongosh_0.2.2_amd64.deb -> 404'
          );
        });
      });

      describe('probePlatformDownloadLink', () => {
        beforeEach(() => {
          nock.cleanAll();
          nockLink(links.linux, 200);
          nockLink(links.debian, 404);
        });

        afterEach(() => {
          if (!nock.isDone()) {
            throw new Error('HTTP calls to link urls were not done');
          }
        });

        it('returns the result of the probe', async() => {
          const probe1 = await probePlatformDownloadLink({
            'arch': 'x64',
            'os': 'linux',
            'name': 'Linux 64-bit',
            'download_link': links.linux
          });

          expect(probe1.ok).toBe(true);
          expect(probe1.status).toBe(200);

          const probe2 = await probePlatformDownloadLink({
            'arch': 'x64',
            'os': 'debian',
            'name': 'Debian 64-bit',
            'download_link': links.debian
          });

          expect(probe2.ok).toBe(false);
          expect(probe2.status).toBe(404);
        });
      });

      after(nock.restore);
    });
  });

  describe('validate-config v2', () => {
    const links = {
      darwin_zip: 'https://downloads.mongodb.com/compass/mongosh-0.2.2-darwin.zip',
      darwin_dmg: 'https://downloads.mongodb.com/compass/mongosh-0.2.2-darwin.dmg',
      win32_zip: 'https://downloads.mongodb.com/compass/mongosh-0.2.2-win32.zip',
      win32_msi: 'https://downloads.mongodb.com/compass/mongosh-0.2.2-win32.msi',
      linux: 'https://downloads.mongodb.com/compass/mongosh-0.2.2-linux.tgz',
    };

    const downloadCenterJson: DownloadCenterConfigV2 = {
      'platform': [
        {
          'arch': 'x64',
          'os': 'darwin',
          'packages': {
            'title': 'MacOS 64-bit (10.10+)',
            'links': [
              { 'name': 'zip', 'download_link': links.darwin_zip },
              { 'name': 'dmg', 'download_link': links.darwin_dmg }
            ]
          }
        },
        {
          'arch': 'x64',
          'os': 'win32',
          'packages': {
            'title': 'Windows 64-bit (7+)',
            'links': [
              { 'name': 'zip', 'download_link': links.win32_zip },
              { 'name': 'msi', 'download_link': links.win32_msi }
            ]
          }
        },
        {
          'arch': 'x64',
          'os': 'linux',
          'packages': {
            'title': 'Linux 64-bit',
            'links': [
              { 'name': 'zip', 'download_link': links.linux },
            ]
          }
        }
      ],
      'version': '0.2.2',
      'manual_link': 'https://docs.mongodb.org/manual/products/mongosh',
      'release_notes_link': 'https://github.com/mongodb-js/mongosh/releases/tag/v0.2.2',
      'previous_releases_link': '',
      'tutorial_link': 'test'
    };

    describe('validateConfigSchema', () => {
      it('does not throw with a valid config', () => {
        expect(() => {
          validateConfigSchema(downloadCenterJson);
        }).not.toThrow();
      });

      it('throws with a valid config', () => {
        const invalidConfig = { ...downloadCenterJson, manual_link: undefined };

        expect(() => {
          validateConfigSchema(invalidConfig as any);
        }).toThrowError('Invalid configuration: data should have' +
         ' required property \'manual_link\'');
      });
    });

    describe('validateConfigUrls', () => {
      function nockLink(link: string, status: number, headers = {}): void {
        const url = new URL(link);
        nock(url.origin).head(url.pathname).reply(status, undefined, headers);
      }

      describe('when all links are correct', () => {
        beforeEach(() => {
          nock.cleanAll();
          nockLink(links.darwin_zip, 302, { 'Location': 'http://example.com/redirect' });
          nockLink(links.darwin_dmg, 302, { 'Location': 'http://example.com/redirect' });
          nockLink(links.win32_zip, 200);
          nockLink(links.win32_msi, 200);
          nockLink(links.linux, 200);
          nockLink('http://example.com/redirect', 200);
        });

        afterEach(() => {
          if (!nock.isDone()) {
            throw new Error('HTTP calls to link urls were not done');
          }
        });

        it('does not throw if all the downloads are ok', async() => {
          await expect(validateDownloadLinks(downloadCenterJson))
            .resolves.toBeUndefined();
        });
      });

      describe('with broken links', () => {
        beforeEach(() => {
          nock.cleanAll();
          nockLink(links.darwin_dmg, 200);
          nockLink(links.darwin_zip, 200);
          nockLink(links.win32_msi, 302, { 'Location': 'http://example.com/redirect' });
          nockLink(links.win32_zip, 200);
          nockLink(links.linux, 404);
          nockLink('http://example.com/redirect', 404);
        });

        afterEach(() => {
          if (!nock.isDone()) {
            throw new Error('HTTP calls to link urls were not done');
          }
        });

        it('throws reporting broken urls', async() => {
          const error = await (
            validateDownloadLinks(downloadCenterJson).catch((e) => e)
          );

          expect(error).not.toBeUndefined();
          expect(error.message).toEqual(
            'Download center urls broken:\n' +
              `- ${links.win32_msi} -> 404\n` +
              `- ${links.linux} -> 404`
          );
        });
      });

      describe('probePlatformDownloadLink', () => {
        beforeEach(() => {
          nock.cleanAll();
          nockLink(links.linux, 200);
          nockLink(links.win32_msi, 404);
        });

        afterEach(() => {
          if (!nock.isDone()) {
            throw new Error('HTTP calls to link urls were not done');
          }
        });

        it('returns the result of the probe', async() => {
          const probe1 = await probePlatformDownloadLink({
            'download_link': links.linux
          });

          expect(probe1.ok).toBe(true);
          expect(probe1.status).toBe(200);

          const probe2 = await probePlatformDownloadLink({
            'download_link': links.win32_msi
          });

          expect(probe2.ok).toBe(false);
          expect(probe2.status).toBe(404);
        });
      });

      after(nock.restore);
    });
  });
});
