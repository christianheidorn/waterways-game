<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="csrf-token" content="{{ csrf_token() }}">
        <title>{{ $map->name }} — {{ config('app.name') }}</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml">
        @fonts
        <script>
            window.__WATERWAYS__ = @json($config);
        </script>
        @vite(['resources/game/main.ts'])
    </head>
    <body class="ww-body">
        <div id="game-root"></div>
    </body>
</html>
