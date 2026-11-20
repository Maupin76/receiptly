// api/scan.js - Secure Vercel Serverless Function for Receipt & Multi-Page Invoice Extraction
// Keeps GEMINI_API_KEY safely on the server so mobile users never see it.

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "Server configuration error: Missing GEMINI_API_KEY." });
  }

  try {
    const { pages, taxonomy } = req.body || {};

    if (!Array.isArray(pages) || pages.length === 0) {
      return res.status(400).json({ error: "No receipt pages provided." });
    }

    if (pages.length > 15) {
      return res
        .status(400)
        .json({ error: "Maximum 15 pages per document allowed." });
    }

    const taxonomyGuide = Object.entries(taxonomy || {})
      .map(
        ([cat, subs]) =>
          `- ${cat}: [${Array.isArray(subs) ? subs.join(", ") : ""}]`,
      )
      .join("\n");

    const totalPages = pages.length;
    const todayIso = new Date().toISOString().split("T")[0];

    const prompt = `You are an expert restaurant and food truck bookkeeper. Analyze the attached ${totalPages} image(s) representing consecutive pages (Page 1 to Page ${totalPages}) of ONE single supplier receipt or multi-page invoice, and extract all purchase details into structured JSON.
Rules:
1. Treat all ${totalPages} attached image(s) as consecutive pages of ONE single document.
2. Extract the shared retailer/vendor name (e.g., Restaurant Depot, Costco, US Foods, Sysco, WinCo, Walmart).
3. Extract the purchase/invoice date in YYYY-MM-DD format (if unclear, use today's date: ${todayIso}).
4. Extract every purchased line item across ALL ${totalPages} pages into a single unified list with its clean name, numeric quantity (default 1), unit price, total line cost, and which page number (1 to ${totalPages}) the item appeared on.
5. IMPORTANT FOR MULTI-PAGE INVOICES: Ignore intermediate "Page Subtotal", "Continued on next page", or "Balance Brought Forward" lines so items are NEVER double-counted. Only extract the final Tax and final Invoice/Receipt Grand Total (usually on Page ${totalPages}).
6. Categorize EVERY item into the most accurate Primary Category and Subcategory using this taxonomy:
${taxonomyGuide}`;

    const messageParts = [{ text: prompt }];
    pages.forEach((pg, idx) => {
      messageParts.push({
        text: `--- DOCUMENT PAGE ${idx + 1} OF ${totalPages} ---`,
      });
      messageParts.push({
        inlineData: {
          mimeType: pg.mimeType || "image/jpeg",
          data: pg.base64Data,
        },
      });
    });

    const payload = {
      contents: [{ role: "user", parts: messageParts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            retailer: { type: "STRING" },
            date: { type: "STRING" },
            tax: { type: "NUMBER" },
            receiptTotal: { type: "NUMBER" },
            items: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  name: { type: "STRING" },
                  pageNumber: { type: "INTEGER" },
                  quantity: { type: "NUMBER" },
                  unitPrice: { type: "NUMBER" },
                  totalCost: { type: "NUMBER" },
                  category: { type: "STRING" },
                  subcategory: { type: "STRING" },
                },
                required: [
                  "name",
                  "pageNumber",
                  "quantity",
                  "unitPrice",
                  "totalCost",
                  "category",
                  "subcategory",
                ],
              },
            },
          },
          required: ["retailer", "date", "tax", "receiptTotal", "items"],
        },
      },
    };

    // Try gemini-3-flash-preview first, then fall back to gemini-3.8-flash
    const modelsToTry = ["gemini-3-flash-preview", "gemini-3.8-flash"];
    let lastErrorMessage = "Unknown Gemini API error";

    for (const modelName of modelsToTry) {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
      const geminiRes = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (geminiRes.ok) {
        const result = await geminiRes.json();
        const jsonText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!jsonText) {
          return res.status(502).json({ error: "Empty response from AI." });
        }
        return res.status(200).json(JSON.parse(jsonText));
      }

      const errBody = await geminiRes.text();
      console.error(
        `Gemini API error (${modelName}):`,
        geminiRes.status,
        errBody,
      );
      try {
        const parsedErr = JSON.parse(errBody);
        lastErrorMessage =
          parsedErr?.error?.message || `HTTP ${geminiRes.status}`;
      } catch {
        lastErrorMessage = `HTTP ${geminiRes.status}`;
      }
    }

    return res
      .status(502)
      .json({ error: `AI extraction failed: ${lastErrorMessage}` });
  } catch (err) {
    console.error("Serverless scan handler error:", err);
    return res
      .status(500)
      .json({ error: `Unexpected server error: ${err.message}` });
  }
}
