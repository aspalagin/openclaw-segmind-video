# openclaw-segmind-video

OpenClaw video generation provider for Segmind Seedance 2.0.

The plugin registers a `segmind` provider for OpenClaw's
`video_generate`/video-generation contract and supports:

- Seedance 2.0 full, fast, and mini models.
- Text-to-video.
- Image-to-video with first/last frame inputs.
- Reference-to-video mode for subject-preserving reference images.
- Reference videos and reference audio inputs.
- 480p, 720p, 1080p, and 4K where Segmind supports them.
- Remaining-credit metadata from Segmind response headers.
- Saving generated videos into the OpenClaw media store for delivery.

## Requirements

- OpenClaw with `videoGenerationProviders` plugin contract support.
- Node.js 20+.
- A Segmind API key.
- Optional: Yandex Disk OAuth token for local file references.

Local file references must be uploaded somewhere Segmind can fetch them. This
plugin includes a Yandex Disk uploader because it is available in the original
production environment. Pure HTTP(S) input URLs do not require Yandex Disk.

## Install

```bash
git clone https://github.com/aspalagin/openclaw-segmind-video.git
cd openclaw-segmind-video
npm run check
```

Copy or install the plugin into your OpenClaw extensions directory, then enable
it in `openclaw.json`.

## Configuration

Example plugin entry:

```json
{
  "plugins": {
    "paths": ["/path/to/openclaw-segmind-video"],
    "entries": {
      "segmind": {
        "enabled": true,
        "config": {
          "apiKey": { "source": "file", "provider": "filemain", "id": "/SEGMIND_API_KEY" },
          "baseUrl": "https://api.segmind.com"
        }
      }
    },
    "allow": ["segmind"]
  }
}
```

Environment fallback:

```bash
export SEGMIND_API_KEY=...
```

Optional local-reference upload:

```bash
export YANDEX_DISK_TOKEN=...
export YANDEX_DISK_REFS_DIR=/segmind-refs
```

## Models

Provider model ids:

- `segmind/seedance-2.0`
- `segmind/seedance-2.0-fast`
- `segmind/seedance-2.0-mini`
- `segmind/seedance-2.0/reference-to-video`
- `segmind/seedance-2.0-fast/reference-to-video`
- `segmind/seedance-2.0-mini/reference-to-video`

The plugin also accepts `segmind/sedance-2.0` as a compatibility alias.

## Provider Options

Common options:

- `mode`: `reference-to-video`, `image-to-video`, `text-to-video`, `r2v`, `i2v`, `t2v`
- `seed`: number
- `return_last_frame`: boolean
- `skip_moderation`: boolean
- `first_frame_url`: string
- `last_frame_url`: string

Important distinction:

- Image-to-video treats an image as a first frame.
- Reference-to-video treats images as subject references and is the right mode
  when you want Segmind to preserve a person's or object's identity across the
  clip.

## Development

```bash
npm run check
```

## License

MIT
