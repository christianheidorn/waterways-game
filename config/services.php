<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | This file is for storing the credentials for third party services such
    | as Resend, Postmark, AWS, and more. This file provides the de facto
    | location for this type of information, allowing packages to have
    | a conventional file to locate the various service credentials.
    |
    */

    'postmark' => [
        'key' => env('POSTMARK_API_KEY'),
    ],

    'resend' => [
        'key' => env('RESEND_API_KEY'),
    ],

    'ses' => [
        'key' => env('AWS_ACCESS_KEY_ID'),
        'secret' => env('AWS_SECRET_ACCESS_KEY'),
        'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
    ],

    'terrarium' => [
        'url' => env('TERRARIUM_URL', 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'),
    ],

    'overpass' => [
        // Optional single endpoint, tried before the list below.
        'url' => env('OVERPASS_URL'),
        // Endpoints tried in order until one answers (comma separated in OVERPASS_URLS).
        'urls' => array_values(array_filter(explode(',', (string) env(
            'OVERPASS_URLS',
            'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter',
        )))),
    ],

    'openrouter' => [
        // Fallback when no key is stored in the studio (Settings → AI).
        'key' => env('OPENROUTER_API_KEY'),
        'url' => env('OPENROUTER_URL', 'https://openrouter.ai/api/v1'),
    ],

    'meshy' => [
        // Fallback when no key is stored in the studio (Settings → AI).
        'key' => env('MESHY_API_KEY'),
        'url' => env('MESHY_URL', 'https://api.meshy.ai'),
    ],

    'slack' => [
        'notifications' => [
            'bot_user_oauth_token' => env('SLACK_BOT_USER_OAUTH_TOKEN'),
            'channel' => env('SLACK_BOT_USER_DEFAULT_CHANNEL'),
        ],
    ],

];
