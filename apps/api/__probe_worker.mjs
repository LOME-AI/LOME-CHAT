import { AwsClient } from 'aws4fetch';

const aws = new AwsClient({
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  service: 's3',
  region: 'auto',
  retries: 0,
});

export default {
  async fetch() {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5]);
    const body = Uint8Array.from(bytes).buffer;
    const url = 'http://localhost:9000/hushbox-media-dev/probe/object-key';
    try {
      const response = await aws.fetch(url, {
        method: 'PUT',
        body,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const text = await response.text();
      return Response.json({ ok: response.ok, status: response.status, body: text.slice(0, 500) });
    } catch (error) {
      return Response.json({
        threw: true,
        name: error?.name,
        message: String(error?.message ?? error),
        stack: String(error?.stack ?? '').slice(0, 800),
      });
    }
  },
};
