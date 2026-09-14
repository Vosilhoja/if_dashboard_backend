require('dotenv').config();
const { runAIChat } = require('./src/ai/client');

const testPrompts = [
  'Почему результат неправильно показывает и где найти первоисточник?',
  'Как переписать скрипт оператора, чтобы снизить отказы?',
  'Сколько времени мы потеряли из-за звонков на 681 зарубежный номер?',
  'Составь пошаговую инструкцию по дожиму незавершённых регистраций через SMS',
  'Куда перейти на сайте, чтобы посмотреть сырые строки обзвонов?'
];

async function runTests() {
  console.log('--- STARTING AI AUDIT PROMPT VERIFICATION ---');
  for (let i = 0; i < testPrompts.length; i++) {
    const p = testPrompts[i];
    console.log(`\n======================================================`);
    console.log(`[TEST ${i + 1}] PROMPT: "${p}"`);
    console.log(`======================================================`);
    try {
      const response = await runAIChat({
        messages: [{ role: 'user', content: p }]
      });
      console.log(`[RESPONSE LENGTH]: ${response.reply?.length} chars`);
      console.log(`[MODEL USED]: ${response.modelUsed}`);
      console.log(`[SNIPPET]:\n${response.reply?.slice(0, 450)}...\n`);
    } catch (err) {
      console.error(`[TEST ${i + 1} FAILED]:`, err);
    }
  }
  console.log('\n--- ALL 5 AI PROMPT TESTS COMPLETED ---');
}

runTests();
