import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type, FunctionDeclaration, Content } from '@google/genai';
import path from 'path';

const app = express();
app.use(express.json());
const PORT = 3000;

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// Gemini setup
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// In-memory chat history (for demo purposes)
const chatHistories: Record<string, Content[]> = {};

const saveLeadDeclaration: FunctionDeclaration = {
  name: 'save_lead',
  description: 'Saves a real estate lead to the database when all 5 details are collected.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING, description: 'The name of the lead.' },
      phone: { type: Type.STRING, description: 'The phone number of the lead.' },
      propertyType: { type: Type.STRING, description: 'The type of property they are interested in (e.g., apartment, house, commercial).' },
      budget: { type: Type.STRING, description: 'Their budget for the property.' },
      location: { type: Type.STRING, description: 'The desired location or neighborhood.' },
    },
    required: ['name', 'phone', 'propertyType', 'budget', 'location'],
  },
};

const systemInstruction = `You are a helpful WhatsApp Real Estate Bot. Your goal is to collect 5 key details from potential leads:
1. Name
2. Phone Number
3. Property Type (e.g., apartment, house, commercial)
4. Budget
5. Desired Location

Be conversational, polite, and ask for one or two details at a time. Do not overwhelm the user.
Once you have collected ALL 5 details, you MUST call the 'save_lead' function to save the lead.
After saving the lead, thank the user and let them know an agent will contact them soon.`;

app.post('/api/whatsapp', async (req, res) => {
  try {
    const { message, from } = req.body;

    if (!message || !from) {
      return res.status(400).json({ error: 'Missing message or from field' });
    }

    if (!chatHistories[from]) {
      chatHistories[from] = [];
    }

    const history = chatHistories[from];
    history.push({ role: 'user', parts: [{ text: message }] });

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
      if (call.name === 'save_lead') {
        const args = call.args as any;
        
        // Save to Supabase
        if (supabaseUrl && supabaseKey) {
          const { error } = await supabase
            .from('real_estate_leads')
            .insert([
              {
                name: args.name,
                phone: args.phone,
                property_type: args.propertyType,
                budget: args.budget,
                location: args.location,
              },
            ]);
            
          if (error) {
            console.error('Supabase error:', error);
            botReply = "I'm sorry, there was an error saving your details. Please try again later.";
          } else {
            botReply = "Thank you! I've saved your details. One of our agents will contact you shortly.";
          }
        } else {
          console.warn('Supabase credentials not configured. Skipping DB insert.');
          botReply = "Thank you! I've saved your details (Mocked - configure Supabase to actually save). One of our agents will contact you shortly.";
        }
        
        history.push({ role: 'model', parts: [{ functionCall: call }] });
        history.push({ role: 'user', parts: [{ functionResponse: { name: 'save_lead', response: { status: 'success' } } }] });
        
        // Get final thank you message from model
        const finalResponse = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: history,
            config: { systemInstruction }
        });
        
        botReply = finalResponse.text || botReply;
        history.push({ role: 'model', parts: [{ text: botReply }] });
      }
    } else {
      botReply = response.text || "I didn't quite get that.";
      history.push({ role: 'model', parts: [{ text: botReply }] });
    }

    res.json({ reply: botReply });
  } catch (error) {
    console.error('Error processing message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vite middleware setup
async function startServer() {
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(\`Server running on http://localhost:\${PORT}\`);
  });
}

startServer();
