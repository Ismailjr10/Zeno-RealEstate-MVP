import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type, FunctionDeclaration, Content } from '@google/genai';
import path from 'path';

const app = express();
app.use(express.json());

// Initialize Supabase lazily
let supabase: any = null;
function getSupabase() {
  if (!supabase) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && supabaseKey) {
      supabase = createClient(supabaseUrl, supabaseKey);
    }
  }
  return supabase;
}

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// In-memory chat history (for demo purposes)
const chatHistories: Record<string, Content[]> = {};

const saveLeadDeclaration: FunctionDeclaration = {
  name: 'save_lead_to_supabase',
  description: 'Saves a real estate lead to the database when all required details are collected.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING, description: 'The name of the lead.' },
      phone: { type: Type.STRING, description: 'The phone number of the lead.' },
      intent: { type: Type.STRING, description: 'The intent of the lead (e.g., buying, renting, selling).' },
      location: { type: Type.STRING, description: 'The desired location or neighborhood.' },
      budget: { type: Type.STRING, description: 'Their budget for the property.' },
      timeline: { type: Type.STRING, description: 'Their timeline for moving or purchasing.' },
    },
    required: ['name', 'phone', 'intent', 'location', 'budget', 'timeline'],
  },
};

const systemInstruction = `You are a conversational lead filter. Your main job is to fill the save_lead_to_supabase function.

Do not tell the user you are "saving data." Just keep the conversation natural and polite.

The Moment of Truth: The very instant you have gathered all the required parameters (Name, Phone, Intent, Location, Budget, Timeline), STOP and execute the save_lead_to_supabase tool.`;

// Whapi Outbound Integration
async function sendWhatsAppMessage(to: string, body: string) {
  if (!process.env.WHAPI_TOKEN) {
    console.warn('WHAPI_TOKEN is missing. Skipping WhatsApp message.');
    return;
  }
  try {
    const response = await fetch('https://gate.whapi.cloud/messages/text', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHAPI_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        typing_time: 0,
        to: to,
        body: body
      })
    });
    if (!response.ok) {
      console.error('Failed to send WhatsApp message:', await response.text());
    }
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
  }
}

app.post('/api/whatsapp', async (req, res) => {
  try {
    // Webhook Logic: Extract sender's ID (from) and text (body.text.body)
    // Supports both Whapi payload and local simulator payload
    const incomingMessage = req.body.messages?.[0] || req.body;
    const from = incomingMessage.from;
    const messageText = incomingMessage.text?.body || incomingMessage.message;

    if (!messageText || !from) {
      return res.status(400).json({ error: 'Missing message or from field' });
    }

    if (!chatHistories[from]) {
      chatHistories[from] = [];
    }

    const history = chatHistories[from];
    history.push({ role: 'user', parts: [{ text: messageText }] });

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: history,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: [saveLeadDeclaration] }],
      },
    });

    let botReply = '';

    if (response.functionCalls && response.functionCalls.length > 0) {
      const call = response.functionCalls[0];
      if (call.name === 'save_lead_to_supabase') {
        const args = call.args as any;
        
        // Save to Supabase
        const supabaseClient = getSupabase();
        if (supabaseClient) {
          const { error } = await supabaseClient
            .from('real_estate_leads')
            .insert([
              {
                name: args.name,
                phone: args.phone,
                intent: args.intent,
                location: args.location,
                budget: args.budget,
                timeline: args.timeline,
              },
            ]);
            
          if (error) {
            console.error('Supabase error:', error);
            botReply = "I'm sorry, there was an error processing your request. Please try again later.";
          } else {
            botReply = "Thank you, Sir/Ma. I've sent your details to our head agent. They will reach out to you on WhatsApp within the next 30 minutes to finalize the viewing. Anything else I can help with?";
          }
        } else {
          console.warn('Supabase credentials not configured. Skipping DB insert.');
          botReply = "Thank you, Sir/Ma. I've sent your details to our head agent. They will reach out to you on WhatsApp within the next 30 minutes to finalize the viewing. Anything else I can help with?";
        }
        
        history.push({ role: 'model', parts: [{ functionCall: call }] });
        history.push({ role: 'user', parts: [{ functionResponse: { name: 'save_lead_to_supabase', response: { status: 'success' } } }] });
        history.push({ role: 'model', parts: [{ text: botReply }] });
      }
    } else {
      botReply = response.text || "I didn't quite get that.";
      history.push({ role: 'model', parts: [{ text: botReply }] });
    }

    // Send the reply back to the user's real WhatsApp
    await sendWhatsAppMessage(from, botReply);

    res.json({ reply: botReply });
  } catch (error) {
    console.error('Error processing message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vite middleware setup for non-production
async function setupVite() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}

setupVite();

// For local development / AI Studio preview to keep the simulator working,
// and for Cloud Run deployments. Vercel sets the VERCEL env var, so we skip it there.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT as number, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Export default app for Vercel Serverless Function compatibility
export default app;
