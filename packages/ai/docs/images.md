# Images
## Image input

Models with vision capabilities can process images. You can check if a model supports images via the `input` property. If you pass images to a non-vision model, they are silently ignored.

```typescript
import { readFileSync } from 'node:fs';
import { builtinModels } from '@candy/ai/providers/all';

const models = builtinModels();
const model = models.getModel('openai', 'gpt-4o-mini')!;

// Check if model supports images
if (model.input.includes('image')) {
  console.log('Model supports vision');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await models.complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ],
    timestamp: Date.now()
  }]
});

// Access the response
for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
```

## Image Generation

Image models live in the same `Models` collection and on the same `Provider` as chat models, so one credential per provider covers both. They are typed `ImageModel` with `type: "image"` and are used through `generateImages()`, a one-shot API that waits for the provider response and returns the final `AssistantImages` result. Do not use the chat/stream APIs for them; `stream()` rejects image models.

### Basic Image Generation

```typescript
import { builtinModels } from '@candy/ai/providers/all';

const models = builtinModels();

const model = models.getModelOfType('image', 'openrouter', 'google/gemini-2.5-flash-image')!;

// Auth resolves through the provider (OPENROUTER_API_KEY here); explicit apiKey wins
const result = await models.generateImages(model, {
  input: [{ type: 'text', text: 'Generate a red circle on a plain white background.' }]
});

for (const block of result.output) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'image') {
    console.log(block.mimeType);
    console.log(block.data.substring(0, 32));
  }
}
```

`generateImages()` accepts only `ImageModel` values. If an upstream model supports both chat and image generation, the catalog contains separate entries with the same provider and ID: `getModel()` returns its chat operation and `getModelOfType('image', ...)` returns its image operation. Failures never reject; they return an `AssistantImages` with `stopReason: "error"`, including unknown providers, unconfigured auth, and providers without an image implementation.

A provider declares `images` as a map from `model.api` to an implementation with `generateImages()`. Put image models in the same catalog as chat models; image-only factories may omit `api`. See [`createProvider()`](providers.md#createprovider) and [CreateProviderOptions](../src/models.ts) for the contract.

Some models also support image input:

```typescript
import { readFileSync } from 'fs';

const imageBuffer = readFileSync('input.png');
const result = await models.generateImages(model, {
  input: [
    { type: 'text', text: 'Create a variation of this image with a blue background.' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ]
});
```

Check capabilities on the model metadata:

```typescript
console.log(model.input);  // ['text'] or ['text', 'image']
console.log(model.output); // ['image'] or ['image', 'text']
```

### Capabilities and options

Image generation does not call tools. Check `model.input` and `model.output` for supported content; `AssistantImages.output` can contain base64 image and text blocks. Requests support authentication overrides, cancellation, payload/response inspection, and usage accounting. The built-in image implementation is OpenRouter; custom providers can register their own implementations.
