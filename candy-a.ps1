Push-Location -LiteralPath 'C:\Users\Ame\Documents\a'
try {
	& node "$PSScriptRoot/packages/coding-agent/dist/bundle/cli.js" @args
	$exitCode = $LASTEXITCODE
} finally {
	Pop-Location
}
exit $exitCode
