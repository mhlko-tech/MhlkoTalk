$ErrorActionPreference = "Stop"
$ffmpeg = Join-Path $env:APPDATA "com.mhlko.talk\recorder-tools\ffmpeg.exe"
$temporaryMkv = Join-Path $env:TEMP "mhtalk-native-engine-test.recording.mkv"
$finalMp4 = Join-Path $env:TEMP "mhtalk-native-engine-test.mp4"
$probeLog = Join-Path $env:TEMP "mhtalk-native-engine-test.probe.log"
Remove-Item -LiteralPath $temporaryMkv, $finalMp4, $probeLog -Force -ErrorAction SilentlyContinue
$port = 49327
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $ffmpeg
$startInfo.Arguments = "-y -hide_banner -loglevel error -f lavfi -i ddagrab=output_idx=0:framerate=30:draw_mouse=1 -thread_queue_size 2048 -f s16le -ar 48000 -ac 2 -i tcp://127.0.0.1:${port}?listen=1 -vf hwdownload,format=bgra -map 0:v:0 -c:v h264_nvenc -preset p5 -tune hq -rc vbr -cq 23 -pix_fmt yuv420p -g 60 -map 1:a:0 -c:a aac -b:a 192k -f matroska `"$temporaryMkv`""
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$null = $process.Start()
$client = [System.Net.Sockets.TcpClient]::new()
for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
    try {
        $client.Connect("127.0.0.1", $port)
        break
    } catch {
        Start-Sleep -Milliseconds 40
    }
}
if (-not $client.Connected) { throw "Audio TCP connection failed" }
$stream = $client.GetStream()
$silence = [byte[]]::new(19200)
for ($index = 0; $index -lt 12; $index += 1) {
    $stream.Write($silence, 0, $silence.Length)
    Start-Sleep -Milliseconds 100
}
$process.StandardInput.WriteLine("q")
$process.StandardInput.Flush()
$client.Close()
if (-not $process.WaitForExit(10000)) {
    $process.Kill()
    throw "Recorder did not stop"
}
& $ffmpeg -y -hide_banner -loglevel error -i $temporaryMkv -map 0 -c copy -movflags +faststart $finalMp4
if ($LASTEXITCODE -ne 0) { throw "MP4 remux failed" }
$probeProcess = Start-Process -FilePath $ffmpeg -ArgumentList "-hide_banner", "-i", $finalMp4 -WindowStyle Hidden -RedirectStandardError $probeLog -PassThru -Wait
Get-Content -LiteralPath $probeLog | Select-String "Video:|Audio:|Duration:"
Get-Item -LiteralPath $temporaryMkv, $finalMp4 | Select-Object Name, Length
Remove-Item -LiteralPath $temporaryMkv, $finalMp4, $probeLog -Force -ErrorAction SilentlyContinue
