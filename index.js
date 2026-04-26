const { execSync } = require('child_process')
try { execSync('npx playwright install chromium --with-deps', { stdio: 'inherit' }) } catch(e) {}

const express = require('express')
const cors = require('cors')
const multer = require('multer')
const Anthropic = require('@anthropic-ai/sdk')
const { chromium } = require('playwright')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const upload = multer({ storage: multer.memoryStorage() })
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Step 1: Claude reads the receipt image
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
          text: `Extract the survey information from this grocery receipt.
Return ONLY valid JSON with these fields:
{
  "survey_url": "full URL from receipt",
  "store_name": "store name",
  "store_number": "store number if visible",
  "transaction_number": "transaction number",
  "visit_date": "YYYY-MM-DD format"
}
If a field is not visible, use null.`
        }
      ]
    }]
  })

  const text = response.content[0].text
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  return JSON.parse(jsonMatch ? jsonMatch[0] : text.replace(/```json|```/g, '').trim())
}

// Step 2: Claude fills the survey using Playwright
async function fillSurvey(surveyData, email) {
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })
  const page = await browser.newPage()

  try {
    let url = surveyData.survey_url
    if (!url.startsWith('http')) url = 'https://' + url
    await page.goto(url, { waitUntil: 'networkidle' })

    for (let i = 0; i < 15; i++) {
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 })
      const base64 = screenshot.toString('base64')

      const action = await claude.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: base64 }
            },
            {
              type: 'text',
              text: `RESPOND WITH ONLY A JSON OBJECT — no preamble, no explanation, no analysis. Start your response with { and end with }.

You are filling out a grocery store customer survey.
Survey info: ${JSON.stringify(surveyData)}
Sweepstakes email: ${email}

Look at the current page screenshot and return ONE action as JSON:
{ "action": "click|type|select|done|error", "selector": "css or text", "value": "if typing" }

Rules:
- Rate everything 5/5 or Excellent/Very Satisfied
- Enter the store number, transaction number, and date when asked
- Use "${email}" for any email or contact fields
- action "done" = survey fully submitted with confirmation shown
- action "error" = something went wrong, explain in "value"`
            }
          ]
        }]
      })

      const rawText = action.content[0].text.replace(/```json|```/g, '').trim()
      const jsonMatch = rawText.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        console.log('Non-JSON response, retrying:', rawText)
        await page.waitForTimeout(2000)
        continue
      }
      const parsed = JSON.parse(jsonMatch[0])

      if (parsed.action === 'done') {
        return { success: true, message: parsed.value || 'Survey completed!' }
      }
      if (parsed.action === 'error') {
        throw new Error(parsed.value)
      }
      if (parsed.action === 'click') {
        await page.click(parsed.selector).catch(() => 
          page.getByText(parsed.selector).click()
        )
      }
      if (parsed.action === 'type') {
        await page.fill(parsed.selector, parsed.value)
      }
      if (parsed.action === 'select') {
        await page.selectOption(parsed.selector, parsed.value)
      }

      await page.waitForTimeout(1500)
    }

    return { success: false, message: 'Survey timed out after 15 steps' }

  } finally {
    await browser.close()
  }
}

app.post('/run-survey', upload.single('receipt'), async (req, res) => {
  try {
    const email = req.body.email || 'your@email.com'
    const imageBase64 = req.file.buffer.toString('base64')
    const mimeType = req.file.mimetype

    const surveyData = await extractReceiptData(imageBase64, mimeType)

    if (!surveyData.survey_url) {
      return res.json({ success: false, message: 'No survey URL found on receipt' })
    }

    const result = await fillSurvey(surveyData, email)

    res.json({ ...result, surveyData })

  } catch (err) {
    res.json({ success: false, message: err.message })
  }
})

app.listen(process.env.PORT || 3000, () => console.log('Survey bot ready'))
