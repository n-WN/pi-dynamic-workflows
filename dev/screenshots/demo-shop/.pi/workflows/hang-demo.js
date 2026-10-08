export const meta = { name: "hang-demo", description: "One agent runs a command that does not end", phases: ["Wait"] }
phase("Wait")
return await agent("Run this exact bash command: sleep 300. Then reply with the word done.", { label: "slow command", tools: ["bash"], thinking: "low" })
