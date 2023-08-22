import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import nock from 'nock';
import expect from 'expect';
import S3rver from 's3rver';

import util from 'util';

import {
  DownloadCenter,
  probePlatformDownloadLink,
  S3BucketConfig,
  validateConfigSchema,
  validateDownloadLinks,
} from './download-center';
import { DownloadCenterConfigV2 } from './download-center-config';

const readJSON = (filePath: string) => fs.readFile(filePath, 'utf-8').then(JSON.parse);

describe('download center client', () => {
  let tempDir: string;
  let bucketConfig: S3BucketConfig;
  let downloadCenter: DownloadCenter;

  let s3rver: S3rver;

  before(async function() {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'download-center-tests-')
    );

    s3rver = new S3rver({
      address: '0.0.0.0',
      port: 0,
      silent: false,
      directory: tempDir,
      configureBuckets: [{ name: 'test', configs: [] }],
    });

    const addressInfo = await util.promisify(s3rver.run.bind(s3rver))();

    bucketConfig = {
      bucket: 'test',
      accessKeyId: 'S3RVER',
      secretAccessKey: 'S3RVER',
      endpoint: `http://${addressInfo.address}:${addressInfo.port}`,
      sslEnabled: false,
      s3ForcePathStyle: true,
    };
  });


  after(function(done) {
    s3rver.close(done);
  });

  beforeEach(async() => {
    await fs.mkdir(tempDir, { recursive: true });
    await s3rver.configureBuckets();
    downloadCenter = new DownloadCenter({ ...bucketConfig });
  });

  afterEach(async() => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const fixturePath = (...args: string[]) =>
    path.resolve(__dirname, '..', 'fixtures', ...args);

  describe('upload / download assets', () => {
    it('can upload a file and download it back', async() => {
      await downloadCenter.uploadAsset(
        'prefix/asset.txt',
        createReadStream(fixturePath('asset.txt'))
      );

      const content = await downloadCenter.downloadAsset('prefix/asset.txt');
      expect(content?.toString()).toEqual('content' + os.EOL);
    });
  });

  describe('upload / download config', () => {
    it('can upload and download a valid config file', async() => {
      const validConfig = await readJSON(fixturePath('compass.json'));
      await downloadCenter.uploadConfig('prefix/compass.json', validConfig);

      const config = await downloadCenter.downloadConfig('prefix/compass.json');
      expect(config).toHaveProperty('manual_link');
    });

    it('rejects an invalid configuration (malformed)', async() => {
      const invalidConfig = {
        ...(await readJSON(fixturePath('compass.json'))),
        versions: null,
      };

      const error = await downloadCenter
        .uploadConfig('prefix/compass.json', invalidConfig)
        .catch((e) => e);

      expect(error.message).toEqual(
        'Invalid configuration: data.versions should be array'
      );
    });

    it('rejects an invalid configuration (missing link)', async() => {
      const invalidConfig = {
        ...(await readJSON(fixturePath('compass.json'))),
        versions: [
          {
            _id: '1.21.2',
            version: '1.21.2 (Stable)',
            platform: [
              {
                arch: 'x64',
                os: 'darwin',
                name: 'OS X 64-bit (10.10+)',
                download_link: 'http://example.com/non-existing-url',
              },
            ],
          },
        ],
      };

      const error = await downloadCenter
        .uploadConfig('prefix/compass.json', invalidConfig)
        .catch((e) => e);

      expect(error.message).toEqual(
        'Download center urls broken:\n' +
          '- http://example.com/non-existing-url -> 404'
      );
    });
  });


  describe('validate-config', () => {
    const links = {
      darwin: 'https://downloads.mongodb.com/compass/mongosh-0.2.2-darwin.zip',
      win32: 'https://downloads.mongodb.com/compass/mongosh-0.2.2-win32.zip',
      linux: 'https://downloads.mongodb.com/compass/mongosh-0.2.2-linux.tgz',
      debian: 'https://downloads.mongodb.com/compass/mongosh_0.2.2_amd64.deb',
    };

    const downloadCenterJson = {
      versions: [
        {
          _id: '0.2.2',
          version: '0.2.2',
          platform: [
            {
              arch: 'x64',
              os: 'darwin',
              name: 'MacOS 64-bit (10.10+)',
              download_link: links.darwin,
            },
            {
              arch: 'x64',
              os: 'win32',
              name: 'Windows 64-bit (7+)',
              download_link: links.win32,
            },
            {
              arch: 'x64',
              os: 'linux',
              name: 'Linux 64-bit',
              download_link: links.linux,
            },
            {
              arch: 'x64',
              os: 'debian',
              name: 'Debian 64-bit',
              download_link: links.debian,
            },
          ],
        },
      ],
      manual_link: 'https://docs.mongodb.org/manual/products/mongosh',
      release_notes_link:
        'https://github.com/mongodb-js/mongosh/releases/tag/v0.2.2',
      previous_releases_link: '',
      development_releases_link: '',
      supported_browsers_link: '',
      tutorial_link: 'test',
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
        }).toThrowError(
          'Invalid configuration: data should have' +
            " required property 'manual_link'"
        );
      });
    });

    describe('validateConfigUrls', () => {
      describe('when all links are correct', () => {
        beforeEach(() => {
          nock.cleanAll();
          nockLink(links.darwin, 302, {
            Location: 'http://example.com/redirect',
          });
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
          await expect(
            validateDownloadLinks(downloadCenterJson)
          ).resolves.toBeUndefined();
        });
      });

      describe('with broken links', () => {
        beforeEach(() => {
          nock.cleanAll();
          nockLink(links.darwin, 200);
          nockLink(links.win32, 302, {
            Location: 'http://example.com/redirect',
          });
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
          const error = await validateDownloadLinks(downloadCenterJson).catch(
            (e) => e
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
            arch: 'x64',
            os: 'linux',
            name: 'Linux 64-bit',
            download_link: links.linux,
          });

          expect(probe1.ok).toBe(true);
          expect(probe1.status).toBe(200);

          const probe2 = await probePlatformDownloadLink({
            arch: 'x64',
            os: 'debian',
            name: 'Debian 64-bit',
            download_link: links.debian,
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

      it('throws with an invalid config', () => {
        const invalidConfig = { ...downloadCenterJson, manual_link: undefined };

        expect(() => {
          validateConfigSchema(invalidConfig as any);
        }).toThrowError(/data should have required property \'manual_link\'/);
      });
    });

    describe('validateConfigUrls', () => {
      describe('when all links are correct', () => {
        beforeEach(() => {
          nock.cleanAll();
          nockLink(links.darwin_zip, 302, { 'Location': 'http://example.com/redirect' });
          nockLink(links.darwin_dmg, 200);
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
              `- ${links.linux} -> 404\n` +
              `- ${links.win32_msi} -> 404`
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
