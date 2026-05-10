import axios from "axios";

const DEFAULT_CATEGORIES = ["穿搭", "AI工具", "知识", "创意", "好物", "食谱", "其他"];

function cleanBase64(data: string): string {
  const match = data.match(/^data:image\/[^;]+;base64,(.+)$/s);
  if (match) return match[1];
  return data;
}

async function analyzeScreenshot(
  imageBase64: string,
  userIntent: string,
  userCategory?: string
) {
  const apiKey = process.env.OPENAI_API_KEY || "";
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

  if (!apiKey) throw new Error("OPENAI_API_KEY is required");

  const categoryList = DEFAULT_CATEGORIES.join("、");
  const prompt = `分析截图。意图:${userIntent || "记下来"} 分类:${userCategory || "自动"} 可选:${categoryList}
返回JSON:{"category":"分类","summary":"20字摘要","key_points":["要点1","要点2"],"tags":["标签1","标签2"],"suggested_filename":"文件名"}`;

  console.log(`[LLM] Calling model: ${model}, base_url: ${baseUrl}`);
  console.log(`[LLM] Image base64 length: ${imageBase64.length} chars (~${(imageBase64.length * 0.75 / 1024).toFixed(0)}KB)`);

  const startTime = Date.now();

  const response = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
                detail: "auto",
              },
            },
          ],
        },
      ],
      max_tokens: 300,
    },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 60000,
    }
  );

  const elapsed = Date.now() - startTime;
  console.log(`[LLM] Response received in ${elapsed}ms`);

  const content = response.data.choices[0]?.message?.content;
  if (!content) throw new Error("No content returned from LLM");

  console.log(`[LLM] Raw response: ${content.slice(0, 200)}`);

  const cleaned = content.trim().replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  const result = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

  return {
    category: userCategory || result.category || "其他",
    summary: result.summary || "",
    key_points: Array.isArray(result.key_points) ? result.key_points : [],
    tags: Array.isArray(result.tags) ? result.tags : [],
    suggested_filename: result.suggested_filename || `截图_${Date.now()}`,
  };
}

export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET") {
    return res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "screenshot-intelligence",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const requestStart = Date.now();
  const contentLength = req.headers["content-length"] || "unknown";
  const contentType = req.headers["content-type"] || "unknown";

  console.log(`[API] POST /api/screenshot - content-length: ${contentLength}, content-type: ${contentType}`);

  try {
    let imageBase64: string | null = null;

    if (req.body?.image_base64) {
      imageBase64 = cleanBase64(req.body.image_base64);
      console.log(`[API] Image from body.image_base64, raw length: ${req.body.image_base64.length}, cleaned: ${imageBase64.length}`);
    } else if (req.body?.image) {
      imageBase64 = cleanBase64(req.body.image);
      console.log(`[API] Image from body.image, raw length: ${req.body.image.length}, cleaned: ${imageBase64.length}`);
    }

    if (!imageBase64) {
      console.log(`[API] No image found in request body. Body keys: ${Object.keys(req.body || {}).join(", ")}`);
      return res.status(400).json({
        success: false,
        error: 'No image provided. Send JSON "image_base64" field.',
      });
    }

    const imageSizeKB = (imageBase64.length * 0.75) / 1024;
    console.log(`[API] Image size: ~${imageSizeKB.toFixed(0)}KB (${(imageSizeKB / 1024).toFixed(2)}MB)`);

    if (imageSizeKB > 4500) {
      console.log(`[API] Image too large: ${imageSizeKB.toFixed(0)}KB exceeds Vercel 4.5MB limit`);
      return res.status(413).json({
        success: false,
        error: `图片太大(${(imageSizeKB / 1024).toFixed(1)}MB)，超过Vercel 4.5MB限制。请在快捷指令中压缩图片后再发送。`,
      });
    }

    const intent = req.body?.user_intent || req.body?.intent || "记下来";
    const category = req.body?.category || undefined;
    const todo = req.body?.todo || undefined;
    const format = req.query.format || req.body?.format || "json";

    console.log(`[API] Processing: intent="${intent}", category="${category || "自动"}", format="${format}"`);

    const analysis = await analyzeScreenshot(imageBase64, intent, category);

    const noteContent = analysis.summary
      ? `${intent}${analysis.summary.replace(/。$/, "")}，${analysis.key_points.join("，")}。${todo ? "待办：" + todo + "。" : ""}`
      : intent;

    const totalElapsed = Date.now() - requestStart;
    console.log(`[API] Complete in ${totalElapsed}ms, category="${analysis.category}", summary="${analysis.summary}"`);

    if (format === "text") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(200).send(noteContent);
    }

    return res.status(200).json({
      success: true,
      category: analysis.category,
      summary: analysis.summary,
      key_points: analysis.key_points,
      tags: analysis.tags,
      suggested_filename: analysis.suggested_filename,
      user_intent: intent,
      todo,
      note_content: noteContent,
    });
  } catch (error: any) {
    const totalElapsed = Date.now() - requestStart;
    const errorMessage =
      error?.response?.data?.message ||
      error?.message ||
      "Analysis failed. Please try again.";

    console.error(`[API] Error after ${totalElapsed}ms: ${errorMessage}`);
    if (error?.response?.status) {
      console.error(`[API] LLM HTTP status: ${error.response.status}`);
    }
    if (error?.code) {
      console.error(`[API] Error code: ${error.code}`);
    }

    if (req.query.format === "text" || req.body?.format === "text") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.status(500).send(`错误: ${errorMessage}`);
    }

    return res.status(500).json({
      success: false,
      error: errorMessage,
      elapsed_ms: totalElapsed,
    });
  }
}

export const config = {
  maxDuration: 60,
};
