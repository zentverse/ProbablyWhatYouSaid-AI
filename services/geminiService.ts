/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { GoogleGenAI, Type } from "@google/genai";
import { TranscriptionSegment, Emotion } from "../types";

const parseJson = (text: string) => {
    try {
        const cleanText = text.replace(/```json\n|\n```/g, "").trim();
        return JSON.parse(cleanText);
    } catch (e) {
        console.error("Failed to parse JSON response:", e);
        return [];
    }
};

export const transcribeAudio = async (
  base64Audio: string,
  mimeType: string
): Promise<{ segments: TranscriptionSegment[]; summary: string }> => {
  if (!process.env.API_KEY) {
    throw new Error("API Key is missing. Please ensure process.env.API_KEY is available.");
  }

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  // Using gemini-3-flash-preview for fast multimodal processing
  const modelId = "gemini-3-flash-preview";

  const prompt = `
    You are an expert audio transcription assistant.
    Process the provided audio file and generate a detailed transcription.
    
    Requirements:
    1. Identify distinct speakers (e.g., Speaker 1, Speaker 2, or names if context allows).
    2. Provide accurate timestamps for each segment (Format: MM:SS).
    3. Detect the primary language of each segment.
    4. If the segment is in a language different than English, also provide the English translation.
    5. Identify the primary emotion of the speaker in this segment. You MUST choose exactly one of the following: Happy, Sad, Angry, Neutral.
    6. Provide a brief summary of the entire audio at the beginning.
    
    Output Format: JSON object with the following structure:
    {
      "summary": "A brief summary of the conversation...",
      "segments": [
        {
          "speaker": "Speaker 1",
          "timestamp": "00:00 - 00:15",
          "content": "Hello, how are you doing today?",
          "language": "English",
          "language_code": "en",
          "translation": "",
          "emotion": "Happy"
        },
        ...
      ]
    }
  `;

  try {
    const response = await ai.models.generateContent({
      model: modelId,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Audio,
            },
          },
          {
            text: prompt,
          },
        ],
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: {
              type: Type.STRING,
              description: "A concise summary of the audio content.",
            },
            segments: {
              type: Type.ARRAY,
              description: "List of transcribed segments with speaker and timestamp.",
              items: {
                type: Type.OBJECT,
                properties: {
                  speaker: { type: Type.STRING },
                  timestamp: { type: Type.STRING },
                  content: { type: Type.STRING },
                  language: { type: Type.STRING },
                  language_code: { type: Type.STRING },
                  translation:  { type: Type.STRING },
                  emotion: { 
                    type: Type.STRING, 
                    description: "The emotion of the speaker.",
                    enum: Object.values(Emotion)
                  },
                },
                required: ["speaker", "timestamp", "content", "language", "language_code", "emotion"],
              },
            },
          },
          required: ["summary", "segments"],
        },
      },
    });

    const text = response.text;
    if (!text) throw new Error("No response text received from Gemini.");

    const data = parseJson(text);
    return data;

  } catch (error) {
    console.error("Gemini Transcription Error:", error);
    throw error;
  }
};