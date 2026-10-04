#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installCodingAgentConsumer, packReleasePackages } from "./coding-agent-consumer.mjs";
import { getPublicWorkspacePackages } from "./package-workspaces.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.includes("--live-openrouter");
if (process.argv.slice(2).some((arg) => arg !== "--live-openrouter")) throw new Error("Usage: node scripts/mcp-acceptance.mjs [--live-openrouter]");
if (live && !process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required for explicit live acceptance");
const temporary = mkdtempSync(join(tmpdir(), "candy-mcp-acceptance-"));
const outputDirectory = join(repository, "node_modules/.cache/mcp-acceptance");
mkdirSync(outputDirectory, { recursive: true });
const report = process.env.CANDY_ACCEPTANCE_REPORT ?? join(outputDirectory, `${live ? "openrouter" : "deterministic"}-${Date.now()}.jsonl`);
const completedScenarios = new Set(existsSync(report) ? readFileSync(report, "utf8").trim().split("\n").map(JSON.parse).filter((entry) => entry.kind === "scenario" && entry.success).map((entry) => entry.scenario) : []);
const record = (data) => appendFileSync(report, `${JSON.stringify(data)}\n`);
record({ kind: "run", live, node: process.version, requestLimit: 12, outputTokensPerRequest: 4096 });

function run(executable, args, env, cwd) {
	return new Promise((complete) => {
		const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", (error) => complete({ exitCode: 1, stdout, stderr: error.message }));
		child.on("exit", (exitCode) => complete({ exitCode, stdout, stderr }));
	});
}

try {
	const consumer = join(temporary, "consumer");
	const tarballs = packReleasePackages(getPublicWorkspacePackages(), join(temporary, "tarballs"));
	installCodingAgentConsumer(consumer, tarballs);
	const agentDir = join(temporary, "agent");
	const workspace = join(temporary, "workspace");
	mkdirSync(agentDir);
	mkdirSync(workspace);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false }, cacheWarming: "off", theme: "dark" }));
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [join(repository, "packages/coding-agent/test/fixtures/mcp/acceptance-server.mjs")] } } }));
	const provider = join(consumer, "acceptance-provider.mjs");
	const common = `import { appendFileSync, readFileSync } from "node:fs";
const report = process.env.CANDY_ACCEPTANCE_REPORT;
const record = data => appendFileSync(report, JSON.stringify(data)+"\\n");
`;
	const liveProvider = `${common}
import { builtinProviders } from "@candy/ai/providers/all";
export function acceptanceProvider() {
 const provider = builtinProviders().find(provider=>provider.id==="openrouter");
 const original = provider.streamSimple.bind(provider);
 provider.streamSimple = (model, context, options) => {
  let requestId; let actualModel;
  return original(model, context, { ...options, maxTokens:4096, maxRetries:0,
   onPayload: payload => {
    const requests=readFileSync(report,"utf8").trim().split("\\n").map(JSON.parse).filter(r=>r.kind==="request");
    const scenario=process.env.CANDY_ACCEPTANCE_SCENARIO;
    const scenarioLimit=scenario==="write"||scenario==="read"?2:4;
    if(requests.length>=12 || requests.filter(r=>r.scenario===scenario).length>=scenarioLimit) throw new Error("Acceptance request limit reached");
    requestId=requests.length+1;
    if(payload.model!=="openrouter/free") throw new Error("Acceptance forbids paid model fallback");
    record({kind:"request",requestId,router:payload.model,maxOutputTokens:payload.max_tokens??payload.max_completion_tokens,scenario});
   },
   onProviderStreamEvent: chunk => {
    if(chunk.model && chunk.model!==actualModel) {actualModel=chunk.model;record({kind:"backend",requestId,actualModel});}
    if(chunk.usage) record({kind:"usage",requestId,usage:chunk.usage});
   }
  });
 };
 return provider;
}
export default candy => candy.registerProvider(acceptanceProvider());
`;
	const deterministicProvider = `${common}
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@candy/ai";
export function acceptanceProvider() {
 const faux=fauxProvider({provider:"acceptance",api:"acceptance",models:[{id:"fixture",name:"Fixture",reasoning:false}]});
 const scenario=process.env.CANDY_ACCEPTANCE_SCENARIO;
 const code=scenario==="node" ? 'const rs=await Promise.all([1,2,3].map(id=>tools.mcp_fixture_query({id}))); text(rs.reduce((n,r)=>n+r.structuredContent.amount,0));'
 : scenario==="bun" ? 'const r=await tools.mcp_fixture_media({}); image(r.content.find(c=>c.type==="image")); text(r.files);'
 : scenario==="write" ? 'store("fixtureAnswer",42); text(load("fixtureAnswer"));' : 'text(load("fixtureAnswer"));';
 const discovery=scenario==="node"||scenario==="bun" ? [fauxAssistantMessage(fauxToolCall("search_mcp_tools",{query:scenario==="node"?"query records":"media image audio"}),{stopReason:"toolUse"})] : [];
 faux.setResponses([...discovery,fauxAssistantMessage(fauxToolCall("codemode",{code}),{stopReason:"toolUse"}),fauxAssistantMessage("ACCEPTANCE_OK")]);
 return faux.provider;
}
export default candy => candy.registerProvider(acceptanceProvider());
`;
	writeFileSync(provider, live ? liveProvider : deterministicProvider);
	const environment = { ...process.env, CANDY_CODING_AGENT_DIR: agentDir, CANDY_CODING_AGENT_SESSION_DIR: join(temporary, "sessions"), CANDY_ACCEPTANCE_REPORT: report, CANDY_OFFLINE: "1" };
	if (!live) delete environment.OPENROUTER_API_KEY;
	const model = live ? "openrouter/free" : "acceptance/fixture";
	const installedCli = join(consumer, "node_modules/@candy/coding-agent/dist/bundle/cli.js");
	const binary = join(repository, "packages/coding-agent/dist", process.platform === "win32" ? "candy.exe" : "candy");
	if (!existsSync(binary)) throw new Error(`Build the Bun binary first: ${binary}`);
	let failed = false;
	for (const [scenario, executable, prefix, prompt] of [
		["node", process.execPath, [installedCli], "Use search_mcp_tools to discover the fixture query tool, then use codemode to query IDs 1, 2 and 3 in one script. Sum the amounts from each result.structuredContent and show the total, then answer with that total."],
		["bun", binary, [], "Use search_mcp_tools to discover the fixture media tool, then use codemode to call it. Show its image with image(result.content.find(c => c.type === 'image')); print result.files with text() so the saved WAV path is visible. Then confirm the two media outputs."],
	]) {
		if (completedScenarios.has(scenario)) continue;
		console.log(`Running ${live ? "OpenRouter" : "deterministic"} ${scenario} acceptance`);
		const result = await run(executable, [...prefix, "--extension", provider, "--model", model, "--thinking", "off", "--tools", "mcp_fixture_query,mcp_fixture_media", "--mode", "json", "--print", prompt], { ...environment, CANDY_ACCEPTANCE_SCENARIO: scenario }, workspace);
		const events = result.stdout.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
		const toolEnds = events.filter((event) => event.type === "tool_execution_end");
		const scriptResults = toolEnds.filter((event) => event.toolName === "codemode");
		const mediaFiles = scenario === "bun" ? toolEnds.flatMap((event) => event.result.structuredContent?.files ?? []).map((file) => {
			const data = readFileSync(file.path);
			return { ...file, bytes: data.length, validWav: file.mimeType === "audio/wav" && data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WAVE" };
		}) : [];
		const success = result.exitCode === 0 && scriptResults.some((event) => !event.isError) && (scenario === "node" ? JSON.stringify(scriptResults).includes("60") : mediaFiles.some((file) => file.validWav) && scriptResults.some((event) => event.result.content.some((block) => block.type === "image") && JSON.stringify(event.result.content).includes("audio/wav")));
		const compact = toolEnds.map((event) => ({ tool: event.toolName, parent: event.parentToolCallId, isError: event.isError, content: event.result.content.map((block) => block.type === "image" ? { type: block.type, mimeType: block.mimeType, bytes: Buffer.from(block.data, "base64").length } : block), calls: event.result.details?.calls }));
		record({ kind: "scenario", scenario, success, exitCode: result.exitCode, stderr: result.stderr, tools: compact, mediaFiles, scripts: events.filter((event) => event.type === "tool_execution_start" && event.toolName === "codemode").map((event) => event.args.code), modelErrors: events.filter((event) => event.type === "message_end" && event.message?.role === "assistant" && event.message.errorMessage).map((event) => event.message.errorMessage), finalAnswers: events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").map((event) => event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")) });
		if (!success) failed = true;
	}
	const sdkScript = join(consumer, "acceptance-sdk.mjs");
	writeFileSync(sdkScript, `import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentSessionRuntime, ModelRuntime, SessionHistory } from "@candy/coding-agent";
import { acceptanceProvider } from "./acceptance-provider.mjs";
const record=data=>appendFileSync(process.env.CANDY_ACCEPTANCE_REPORT,JSON.stringify(data)+"\\n");
const agentDir=process.env.CANDY_CODING_AGENT_DIR;
const modelRuntime=await ModelRuntime.create({authPath:join(agentDir,"auth.json"),modelsPath:null});
const trace=session=>session.execution.subscribe(event=>{
 if(event.type==="tool_execution_start") record({kind:"sdk-tool-start",scenario:process.env.CANDY_ACCEPTANCE_SCENARIO,id:event.toolCallId,tool:event.toolName,args:event.args,parent:event.parentToolCallId});
 if(event.type==="tool_execution_end") record({kind:"sdk-tool-end",scenario:process.env.CANDY_ACCEPTANCE_SCENARIO,id:event.toolCallId,tool:event.toolName,isError:event.isError,content:event.result.content,parent:event.parentToolCallId});
});
let runtime;
try {
 process.env.CANDY_ACCEPTANCE_SCENARIO="write";
 modelRuntime.registerNativeProvider(acceptanceProvider()); await modelRuntime.refresh({allowNetwork:false});
 const model=modelRuntime.getModel(${JSON.stringify(live ? "openrouter" : "acceptance")},${JSON.stringify(live ? "openrouter/free" : "fixture")});
 const history=SessionHistory.create(process.cwd(),join(agentDir,"sdk-sessions"));
 runtime=await createAgentSessionRuntime({cwd:process.cwd(),agentDir,modelRuntime,model,sessionManager:history,tools:["codemode","mcp_fixture_query"]});
 let unsubscribe=trace(runtime.session);
 await runtime.session.execution.prompt('Use codemode to store the JSON number 42 under the key "fixtureAnswer". Show that it was saved.');
 unsubscribe();
 const file=runtime.session.history.getSessionFile();
 const storeEntries=runtime.session.history.getBranch().filter(e=>e.type==="custom"&&e.customType==="codemode-store");
 const saved=storeEntries.some(e=>e.data.set.fixtureAnswer===42);
 await runtime.dispose(); runtime=undefined;
 process.env.CANDY_ACCEPTANCE_SCENARIO="read";
 if(!${live}) {modelRuntime.registerNativeProvider(acceptanceProvider());await modelRuntime.refresh({allowNetwork:false});}
 runtime=await createAgentSessionRuntime({cwd:process.cwd(),agentDir,modelRuntime,model,sessionManager:SessionHistory.open(file),tools:["codemode","mcp_fixture_query"]});
 unsubscribe=trace(runtime.session);
 await runtime.session.execution.prompt('Use codemode to read load("fixtureAnswer"), print it with text(), and give the stored number in your final answer.');
 unsubscribe();
 const last=runtime.session.history.buildSessionContext().messages.filter(m=>m.role==="toolResult").at(-1);
 const success=saved&&last?.content.some(c=>c.type==="text"&&c.text.includes("42"));
 record({kind:"scenario",scenario:"sdk-resume",success,saved,storeEntries,readResult:last?.content,finalAnswer:runtime.session.history.getLastAssistantText()});
 if(!success) process.exitCode=1;
} finally {await runtime?.dispose();await modelRuntime.dispose();}
`);
	if (!completedScenarios.has("sdk-resume")) {
		console.log(`Running ${live ? "OpenRouter" : "deterministic"} SDK resume acceptance`);
		const sdk = await run(process.execPath, [sdkScript], { ...environment, CANDY_ACCEPTANCE_SCENARIO: "write" }, workspace);
		if (sdk.exitCode !== 0) { failed = true; record({ kind: "error", scenario: "sdk-resume", ...sdk }); }
	}
	record({ kind: "complete", success: !failed });
	console.log(`Acceptance ${failed ? "failed" : "passed"}. Report: ${report}`);
	if (failed) process.exitCode = 1;
} finally {
	if (dirname(temporary) !== resolve(tmpdir()) || !temporary.split(/[\\/]/).at(-1).startsWith("candy-mcp-acceptance-")) throw new Error("Unexpected acceptance cleanup path");
	rmSync(temporary, { recursive: true, force: true });
}
