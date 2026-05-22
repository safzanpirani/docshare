const OCR_PROMPT =
  'Extract all text visible in this image. Output only the extracted text — no preamble, no commentary, no markdown. Preserve line breaks where they are meaningful.'

export async function runOcr(
  imageBytes: ArrayBuffer,
  apiKey: string,
  model: string,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`

  const body = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: 'image/webp',
              data: arrayBufferToBase64(imageBytes),
            },
          },
          { text: OCR_PROMPT },
        ],
      },
    ],
    generationConfig: { temperature: 0 },
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 500)}`)
  }

  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
  }
  const text = json.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('')
  if (typeof text !== 'string') {
    throw new Error('gemini returned no text')
  }
  return text.trim()
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
