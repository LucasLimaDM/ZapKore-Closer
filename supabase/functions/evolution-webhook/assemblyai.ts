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
    }),
  })

  if (!submitRes.ok) {
    const errorBody = await submitRes.text()
    console.error('[AssemblyAI] Submit failed:', submitRes.status, errorBody)
    return null
  }

  const submitData = await submitRes.json()
  const { id: transcriptId } = submitData
  const pollingUrl = `${ASSEMBLY_BASE}/v2/transcript/${transcriptId}`

  console.log(`[AssemblyAI] Transcript submitted, ID: ${transcriptId}. Polling...`)

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const pollRes = await fetch(pollingUrl, { headers: { authorization: apiKey } })

    if (!pollRes.ok) {
      console.error(`[AssemblyAI] Poll failed (${pollRes.status}):`, await pollRes.text())
      continue
    }

    const result = await pollRes.json()
    if (result.status === 'completed') {
      console.log('[AssemblyAI] Transcription completed successfully')
      return result.text || null
    }
    if (result.status === 'error') {
      console.error('[AssemblyAI] Transcription error in result:', result.error)
      return null
    }
    console.log(`[AssemblyAI] Still processing... (status: ${result.status})`)
  }

  console.error('[AssemblyAI] Timeout: 30 polls exceeded')
  return null
}
