import type {
  AiLinerNotesInput,
  AiLinerNotesResult,
  AiLinerNotesTrack,
  AppSettings,
} from '../shared/types.js';

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

interface OpenAiAssistOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

interface OpenAiResponseBody {
  output_text?: unknown;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: unknown;
    }>;
  }>;
  error?: {
    message?: unknown;
  };
}

const LINER_NOTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string' },
    summary: { type: 'string' },
    listeningNotes: {
      type: 'array',
      items: { type: 'string' },
    },
    contextCards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['label', 'value'],
      },
    },
    caution: { type: ['string', 'null'] },
  },
  required: ['headline', 'summary', 'listeningNotes', 'contextCards', 'caution'],
};

export async function generateOpenAiLinerNotes(
  settings: AppSettings,
  input: AiLinerNotesInput,
  options: OpenAiAssistOptions = {},
): Promise<AiLinerNotesResult> {
  const apiKey = settings.openaiApiKey?.trim();
  if (!apiKey) throw new Error('ChatGPT assist key is not configured.');

  const model = normalizeModel(settings.openaiModel);
  const cleanInput = normalizeLinerNotesInput(input);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 18_000);

  try {
    const response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: 700,
        input: [
          {
            role: 'system',
            content:
              'You write compact NewAmp liner notes for a local music player. Use only the supplied JSON context. Do not invent credits, dates, relationships, or trivia. If evidence is sparse, say what the local tags suggest. Return concise JSON only.',
          },
          {
            role: 'user',
            content: JSON.stringify(cleanInput),
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'newamp_liner_notes',
            strict: true,
            schema: LINER_NOTES_SCHEMA,
          },
        },
      }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(openAiError(raw, response.status));
    const parsed = parseOpenAiResponse(raw);
    return normalizeOpenAiLinerNotes(parsed, model, options.now?.() ?? Date.now(), cleanInput.track);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('ChatGPT assist timed out.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeLinerNotesInput(input: AiLinerNotesInput): AiLinerNotesInput {
  return {
    track: normalizeTrack(input?.track),
    lyricHighlights: textList(input?.lyricHighlights, 6, 180),
    lyricsPreview: cleanText(input?.lyricsPreview, 1200) || null,
    localContext: textList(input?.localContext, 8, 220),
  };
}

function normalizeTrack(track: AiLinerNotesTrack): AiLinerNotesTrack {
  return {
    id: Number.isFinite(Number(track?.id)) ? Math.trunc(Number(track.id)) : 0,
    title: cleanText(track?.title, 180) || 'Unknown Title',
    artist: cleanText(track?.artist, 180) || 'Unknown Artist',
    album: cleanText(track?.album, 180) || 'Unknown Album',
    albumArtist: cleanText(track?.albumArtist, 180) || cleanText(track?.artist, 180) || 'Unknown Artist',
    genre: cleanText(track?.genre, 120) || null,
    year: finiteNumber(track?.year),
    duration: finiteNumber(track?.duration),
    rating: finiteNumber(track?.rating) ?? 0,
    ratingScore: finiteNumber(track?.ratingScore),
    bpm: finiteNumber(track?.bpm),
    key: cleanText(track?.key, 40) || null,
    playCount: finiteNumber(track?.playCount) ?? 0,
    skipCount: finiteNumber(track?.skipCount) ?? 0,
  };
}

function parseOpenAiResponse(raw: string): unknown {
  const body = JSON.parse(raw) as OpenAiResponseBody;
  if (body.error?.message) throw new Error(String(body.error.message));
  const text = typeof body.output_text === 'string'
    ? body.output_text
    : body.output
      ?.flatMap((item) => item.content ?? [])
      .map((part) => (part.type === 'output_text' && typeof part.text === 'string' ? part.text : ''))
      .join('');
  if (!text?.trim()) throw new Error('ChatGPT assist returned an empty response.');
  return JSON.parse(text);
}

function normalizeOpenAiLinerNotes(
  raw: unknown,
  model: string,
  generatedAt: number,
  track: AiLinerNotesTrack,
): AiLinerNotesResult {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const headline = cleanText(source.headline, 92) || `${track.artist} - ${track.title}`;
  const summary = cleanText(source.summary, 620) || 'NewAmp could not draft a useful note from the available context.';
  const listeningNotes = textList(source.listeningNotes, 5, 220);
  const contextCards = Array.isArray(source.contextCards)
    ? source.contextCards
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const row = item as Record<string, unknown>;
          const label = cleanText(row.label, 36);
          const value = cleanText(row.value, 120);
          return label && value ? { label, value } : null;
        })
        .filter((item): item is { label: string; value: string } => Boolean(item))
        .slice(0, 4)
    : [];
  return {
    headline,
    summary,
    listeningNotes,
    contextCards,
    caution: cleanText(source.caution, 180) || null,
    generatedAt,
    model,
  };
}

function openAiError(raw: string, status: number): string {
  try {
    const body = JSON.parse(raw) as OpenAiResponseBody;
    if (body.error?.message) return `ChatGPT assist failed (${status}): ${body.error.message}`;
  } catch {
  }
  return `ChatGPT assist failed (${status}).`;
}

function normalizeModel(value: unknown): string {
  const model = typeof value === 'string' ? value.trim() : '';
  return /^[a-zA-Z0-9._:-]{1,80}$/.test(model) ? model : 'gpt-5.4-mini';
}

function textList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = cleanText(item, maxLength);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
