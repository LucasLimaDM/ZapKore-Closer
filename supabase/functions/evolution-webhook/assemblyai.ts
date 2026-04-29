const ASSEMBLY_BASE = 'https://api.assemblyai.com'

export async function transcribeAudio(
  audioBytes: Uint8Array,
  apiKey: string,
): Promise<string | null> {
  const uploadRes = await fetch(`${ASSEMBLY_BASE}/v2/upload`, {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'Content-Type': 'application/octet-stream',
    },
    body: audioBytes,
  })

  if (!uploadRes.ok) {
    console.error('[AssemblyAI] Upload failed:', uploadRes.status, await uploadRes.text())
    return null
  }

  const { upload_url } = await uploadRes.json()

  const submitRes = await fetch(`${ASSEMBLY_BASE}/v2/transcript`, {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: upload_url,
      language_detection: true,
      speech_models: ['universal-3-pro', 'universal-2'],
    }),
  })

  if (!submitRes.ok) {
    console.error('[AssemblyAI] Submit failed:', submitRes.status, await submitRes.text())
    return null
  }

  const { id: transcriptId } = await submitRes.json()
  const pollingUrl = `${ASSEMBLY_BASE}/v2/transcript/${transcriptId}`

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const pollRes = await fetch(pollingUrl, { headers: { authorization: apiKey } })
    if (!pollRes.ok) continue
    const result = await pollRes.json()
    if (result.status === 'completed') return result.text || null
    if (result.status === 'error') {
      console.error('[AssemblyAI] Transcription error:', result.error)
      return null
    }
  }

  console.error('[AssemblyAI] Timeout: 30 polls exceeded')
  return null
}
