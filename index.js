const express = require('express')
const cors = require('cors')
const multer = require('multer')
const Anthropic = require('@anthropic-ai/sdk')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const upload = multer({ storage: multer.memoryStorage() })
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

async function extractReceiptData(imageBase64, mimeType) {
  const response = await claude.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mimeType, data: imageBase64 }
        },
        {
          type: 'text',
          text: `Extract survey information from this grocery receipt.
Return ONLY valid JSON:
{
  "survey_url": "full URL with https:// prefix",
  "store_name": "store name",
  "store_number": "store number",
  "transaction_number": "transaction number",
  "terminal_number": "terminal number if visible",
  "visit_date": "YYYY-MM-DD",
  "visit_time": "HH:MM if visible",
  "total_amount": "total dollar amount if visible"
}
Use null for missing fields. Always include https:// in the URL.`
        }
      ]
    }]
  })

  const text = response.content[0].text
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  return JSON.parse(jsonMatch ? jsonMatch[0] : text.replace(/```json|```/g, '').trim())
}

app.post('/run-survey', upload.single('receipt'), async (req, res) => {
  try {
    const imageBase64 = req.file.buffer.toString('base64')
    const mimeType = req.file.mimetype
    const surveyData = await extractReceiptData(imageBase64, mimeType)

    if (!surveyData.survey_url) {
      return res.json({ success: false, message: 'No survey URL found on receipt' })
    }

    let url = surveyData.survey_url
    url = url.replace(/^http:\/\//i, 'https://')
    if (!url.startsWith('https://')) url = 'https://' + url
    surveyData.survey_url = url

    res.json({ success: true, surveyData })

  } catch (err) {
    res.json({ success: false, message: err.message })
  }
})

app.listen(process.env.PORT || 3000, () => console.log('Survey bot ready'))
