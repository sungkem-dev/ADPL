/**
 * gemini.service.ts — Google Gemini AI Food Recognition Service
 *
 * Replaces LogMeal with Google Gemini 1.5 Flash for food image analysis.
 * Uses the @google/generative-ai SDK to send food images and receive
 * structured nutritional data in JSON format.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO OBTAIN YOUR GEMINI API KEY:
 *   1. Go to https://aistudio.google.com/apikey
 *   2. Click "Create API key" → select a project (or create one)
 *   3. Copy the generated key
 *   4. Add it to server/.env as GEMINI_API_KEY=<your_key>
 *
 * FREE TIER LIMITS (Gemini 1.5 Flash):
 *   - 15 requests per minute (RPM)
 *   - 1 million tokens per minute (TPM)
 *   - 1,500 requests per day (RPD)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { env } from '../config/env.js';
import { createError } from '../middleware/errorHandler.js';

// ─── Initialize Gemini client ─────────────────────────────────────────────────

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: env.GEMINI_MODEL,
  generationConfig: {
    temperature: 0.3,        // Low temperature for consistent, factual results
    topP: 0.8,
    maxOutputTokens: 1024,
    responseMimeType: 'application/json',  // Force JSON-only output
  },
  safetySettings: [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  ],
});

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert nutritionist and food recognition AI. Analyze the food in the provided image and return ONLY a valid JSON object with the following structure. Do NOT include any other text, markdown formatting, or explanation outside the JSON.

RULES:
1. "food_name" must be in Bahasa Indonesia (e.g., "Nasi Goreng", "Ayam Bakar", "Rendang Sapi").
2. If the image contains multiple foods, combine them into a single meal name (e.g., "Nasi Putih dengan Ayam Goreng dan Sambal").
3. "detected_foods" is an array of individual food items detected (also in Bahasa Indonesia).
4. All nutritional values must be realistic estimates for a single standard serving.
5. "confidence_score" reflects how confident you are in the food identification (0.0 to 1.0).
6. If the image does NOT contain food, set "food_name" to "Bukan Makanan", all nutritional values to 0, and "confidence_score" to 0.0.

Required JSON format:
{
  "food_name": "string (Bahasa Indonesia)",
  "detected_foods": ["string", "string"],
  "calories": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "fiber": number,
  "confidence_score": number
}`;

// ─── Shared interface (same contract as the old LogMeal service) ───────────────

export interface NutritionalInfo {
  foodName: string;
  detectedFoods: string[];
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  confidence: number;
  rawResponse: object;
}

// ─── Gemini response shape ────────────────────────────────────────────────────

interface GeminiNutritionResponse {
  food_name: string;
  detected_foods: string[];
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  confidence_score: number;
}

// ─── Main exported function ───────────────────────────────────────────────────

/**
 * analyzeFood — Sends a food image to Gemini 1.5 Flash for analysis.
 *
 * @param imageBuffer - Raw image file buffer
 * @param mimeType    - e.g. 'image/jpeg', 'image/png', 'image/webp'
 * @returns           Parsed nutritional data ready to insert into food_logs
 *
 * @throws 400 if image is not food
 * @throws 502 if Gemini API fails
 */
export async function analyzeFood(
  imageBuffer: Buffer,
  mimeType: string
): Promise<NutritionalInfo> {
  console.log(`[Gemini] Analyzing food image (${imageBuffer.length} bytes, type: ${mimeType})`);

  try {
    // Convert buffer to base64 for Gemini's inline_data format
    const base64Image = imageBuffer.toString('base64');

    const result = await model.generateContent([
      { text: SYSTEM_PROMPT },
      {
        inlineData: {
          mimeType: mimeType,
          data: base64Image,
        },
      },
    ]);

    const response = result.response;
    const textContent = response.text();

    if (!textContent) {
      console.error('[Gemini] Empty response from API');
      throw createError(502, 'Gemini API returned an empty response.');
    }

    // Parse the JSON response
    let parsed: GeminiNutritionResponse;
    try {
      parsed = JSON.parse(textContent);
    } catch (parseErr) {
      console.error('[Gemini] Failed to parse JSON response:', textContent);
      throw createError(502, 'Gemini API returned invalid JSON. Raw response logged.');
    }

    // ── Guard: "not food" detection ─────────────────────────────────────────
    if (
      parsed.food_name === 'Bukan Makanan' ||
      parsed.confidence_score === 0 ||
      (parsed.calories === 0 && parsed.protein === 0 && parsed.carbs === 0 && parsed.fat === 0)
    ) {
      throw createError(
        400,
        'No food detected in the image. Please upload a clear photo of food.'
      );
    }

    const nutritionalInfo: NutritionalInfo = {
      foodName:      parsed.food_name ?? 'Makanan Tidak Dikenali',
      detectedFoods: parsed.detected_foods ?? [parsed.food_name],
      calories:      Math.round(parsed.calories ?? 0),
      protein:       Math.round(parsed.protein ?? 0),
      carbs:         Math.round(parsed.carbs ?? 0),
      fat:           Math.round(parsed.fat ?? 0),
      fiber:         Math.round(parsed.fiber ?? 0),
      confidence:    parseFloat((parsed.confidence_score ?? 0).toFixed(4)),
      rawResponse:   {
        model: env.GEMINI_MODEL,
        gemini_response: parsed,
        usage_metadata: response.usageMetadata,
      },
    };

    console.log(
      `[Gemini] ✓ Analysis complete: "${nutritionalInfo.foodName}" — ` +
      `${nutritionalInfo.calories} kcal (confidence: ${(nutritionalInfo.confidence * 100).toFixed(1)}%)`
    );

    return nutritionalInfo;
  } catch (err: any) {
    // Re-throw known errors (400/502 from our guards above)
    if (err.statusCode) throw err;

    // Handle Gemini SDK errors
    const message = err.message ?? 'Unknown Gemini API error';
    console.error('[Gemini] API call failed:', message);

    if (message.includes('API_KEY')) {
      throw createError(500, 'Gemini API authentication failed. Check GEMINI_API_KEY in .env.');
    }
    if (message.includes('RATE_LIMIT') || message.includes('429')) {
      throw createError(429, 'Gemini API rate limit exceeded. Try again in a moment.');
    }
    if (message.includes('SAFETY')) {
      throw createError(400, 'Image was blocked by Gemini safety filters. Please try a different photo.');
    }

    throw createError(502, `Gemini AI analysis failed: ${message}`);
  }
}
