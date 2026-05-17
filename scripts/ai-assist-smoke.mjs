import assert from 'node:assert/strict';
import {
  generateOpenAiLinerNotes,
  normalizeLinerNotesInput,
} from '../dist-electron/electron/openai-assist.js';

const input = normalizeLinerNotesInput({
  track: {
    id: 7,
    title: 'Street Spirit',
    artist: 'Radiohead',
    album: 'The Bends',
    albumArtist: 'Radiohead',
    genre: 'Alternative',
    year: 1995,
    duration: 253,
    rating: 5,
    ratingScore: 96.5,
    bpm: 138.2,
    key: 'Am',
    playCount: 12,
    skipCount: 1,
  },
  lyricHighlights: ['Rows of houses all bearing down on me'],
  lyricsPreview: 'Rows of houses all bearing down on me\nI can feel their blue hands touching me',
  localContext: ['NewAmp rating: 97/100', '12 plays / 1 skips'],
});

await assert.rejects(
  () => generateOpenAiLinerNotes(
    { openaiApiKey: null, openaiModel: 'gpt-5.4-mini' },
    input,
    { fetchImpl: async () => fakeResponse({}, 200) },
  ),
  /key is not configured/,
);

let captured = null;
const result = await generateOpenAiLinerNotes(
  { openaiApiKey: 'sk-test', openaiModel: 'gpt-5.4-mini' },
  input,
  {
    now: () => 1234,
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return fakeResponse({
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  headline: 'A brittle local-library classic',
                  summary: 'The local tags frame this as a high-rated 1995 Radiohead album cut with strong replay value.',
                  listeningNotes: ['Watch the dynamic rise.', 'The lyric preview points to pressure and release.'],
                  contextCards: [
                    { label: 'Score', value: '96.5 / 100' },
                    { label: 'Library', value: '12 plays' },
                  ],
                  caution: null,
                }),
              },
            ],
          },
        ],
      }, 200);
    },
  },
);

assert.equal(captured.url, 'https://api.openai.com/v1/responses');
assert.equal(captured.init.method, 'POST');
assert.equal(captured.init.headers.Authorization, 'Bearer sk-test');
assert.equal(captured.body.model, 'gpt-5.4-mini');
assert.equal(captured.body.store, false);
assert.equal(captured.body.text.format.type, 'json_schema');
assert.equal(captured.body.text.format.strict, true);
assert.match(captured.body.input[1].content, /Street Spirit/);
assert.equal(result.generatedAt, 1234);
assert.equal(result.model, 'gpt-5.4-mini');
assert.equal(result.headline, 'A brittle local-library classic');
assert.equal(result.contextCards.length, 2);

console.log(JSON.stringify({ ok: true, model: result.model, structured: true }, null, 2));

function fakeResponse(body, status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}
