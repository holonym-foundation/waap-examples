import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const apiKey = process.env.PIMLICO_API_KEY

    if (!apiKey) {
      return NextResponse.json(
        { error: 'Pimlico API key not configured on server' },
        { status: 500 }
      )
    }

    const response = await fetch(`https://api.pimlico.io/v2/sepolia/rpc?apikey=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const data = await response.json()
    return NextResponse.json(data)
  } catch (error) {
    console.error('Pimlico Proxy Error:', error)
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    )
  }
}
