<script lang="ts">
  import { asRaw, buildImageAsDockerTar, fromRaw, triggerDownload } from './lib/oci';

  type Status = 'idle' | 'building' | 'done' | 'error';
  type Theme = 'light' | 'dark';

  const initialTheme: Theme =
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';

  let theme: Theme = $state(initialTheme);

  $effect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  });

  const registry = 'https://pub-40af5d7df1e0402d9a92b982a6599860.r2.dev';
  let baseImageReferenceRaw = $state('alpine:3.23.4');
  let baseImageReference = $derived.by(() => fromRaw(baseImageReferenceRaw));

  let newImageReferenceRaw = $state('my-image:latest');
  let newImageReference = $derived.by(() => fromRaw(newImageReferenceRaw));
  let tarFilename = $derived.by(() => `${asRaw(newImageReference).replace(':', '_')}.tar`);

  let status: Status = $state('idle');
  let buildLog: string = $state('');
  let tar: Uint8Array = new Uint8Array();

  async function triggerBuild() {
    buildLog = '';
    status = 'building';

    try {
      tar = await buildImageAsDockerTar(registry, baseImageReference, newImageReference, (msg) => {
        buildLog += msg;
      });
      status = 'done';
    } catch (e) {
      status = 'error';
      buildLog += `\nError:\n${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function download() {
    triggerDownload(tar, tarFilename);
  }
</script>

<main class="mx-auto max-w-4xl space-y-6 p-6">
  <header class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-3xl font-bold">In-browser container builder</h1>
      <p class="text-base-content/70">Build a container image and download it as a tar archive</p>
    </div>
    <label class="swap swap-rotate" title="Toggle theme">
      <input
        type="checkbox"
        checked={theme === 'dark'}
        onchange={(e) => (theme = (e.currentTarget as HTMLInputElement).checked ? 'dark' : 'light')}
      />
      <svg
        class="swap-off h-6 w-6 fill-current"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        ><path
          d="M5.64,17l-.71.71a1,1,0,0,0,0,1.41,1,1,0,0,0,1.41,0l.71-.71A1,1,0,0,0,5.64,17ZM5,12a1,1,0,0,0-1-1H3a1,1,0,0,0,0,2H4A1,1,0,0,0,5,12Zm7-7a1,1,0,0,0,1-1V3a1,1,0,0,0-2,0V4A1,1,0,0,0,12,5ZM5.64,7.05a1,1,0,0,0,.7.29,1,1,0,0,0,.71-.29,1,1,0,0,0,0-1.41l-.71-.71A1,1,0,0,0,4.93,6.34Zm12,.29a1,1,0,0,0,.7-.29l.71-.71a1,1,0,1,0-1.41-1.41L17,5.64a1,1,0,0,0,0,1.41A1,1,0,0,0,17.66,7.34ZM21,11H20a1,1,0,0,0,0,2h1a1,1,0,0,0,0-2Zm-9,8a1,1,0,0,0-1,1v1a1,1,0,0,0,2,0V20A1,1,0,0,0,12,19ZM18.36,17A1,1,0,0,0,17,18.36l.71.71a1,1,0,0,0,1.41,0,1,1,0,0,0,0-1.41ZM12,6.5A5.5,5.5,0,1,0,17.5,12,5.51,5.51,0,0,0,12,6.5Zm0,9A3.5,3.5,0,1,1,15.5,12,3.5,3.5,0,0,1,12,15.5Z"
        /></svg
      >
      <svg
        class="swap-on h-6 w-6 fill-current"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        ><path
          d="M21.64,13a1,1,0,0,0-1.05-.14,8.05,8.05,0,0,1-3.37.73A8.15,8.15,0,0,1,9.08,5.49a8.59,8.59,0,0,1,.25-2A1,1,0,0,0,8,2.36,10.14,10.14,0,1,0,22,14.05,1,1,0,0,0,21.64,13Zm-9.5,6.69A8.14,8.14,0,0,1,7.08,5.22v.27A10.15,10.15,0,0,0,17.22,15.63a9.79,9.79,0,0,0,2.1-.22A8.11,8.11,0,0,1,12.14,19.73Z"
        /></svg
      >
    </label>
  </header>

  <section class="card bg-base-200">
    <div class="card-body">
      <h2 class="mt-6 card-title">Base image</h2>
      <div class="flex flex-wrap items-end gap-2">
        <label class="form-control">
          <div class="label"><span class="label-text">Reference</span></div>
          <input type="text" class="input-bordered input" bind:value={baseImageReferenceRaw} />
        </label>
      </div>

      <h2 class="mt-6 card-title">New image</h2>
      <div class="flex flex-wrap items-end gap-2">
        <label class="form-control">
          <div class="label"><span class="label-text">Reference</span></div>
          <input type="text" class="input-bordered input" bind:value={newImageReferenceRaw} />
        </label>
      </div>

      <div class="mt-6">
        <button
          class="btn btn-primary"
          onclick={triggerBuild}
          disabled={status === 'building'}
        >
          {#if status === 'building'}
            <span class="loading loading-sm loading-spinner"></span>
          {/if}
          Build
        </button>
      </div>
    </div>
  </section>

  {#if buildLog}
    <section class="card bg-base-200">
      <div class="card-body">
        <h2 class="card-title">Build log</h2>
        <pre class="overflow-x-auto rounded bg-base-300 p-4 text-sm"><code>{buildLog}</code></pre>

        <h2 class="mt-6 card-title">Download</h2>
        <div>
          <button class="btn btn-primary" onclick={download} disabled={status !== 'done'}>
            {#if status === 'building'}
              <span class="loading loading-sm loading-spinner"></span>
            {/if}
            Download {asRaw(newImageReference).replace(':', '_')}.tar
          </button>
        </div>

        {#if status === 'done'}
          <h2 class="mt-6 card-title">Run instructions</h2>
          <p>After downloading, you can run the image as follows:</p>
          <pre class="overflow-x-auto rounded bg-base-300 p-4 text-sm"><code
              >{`docker load -i ${tarFilename}\ndocker run --rm ${newImageReferenceRaw}`}</code
            ></pre>
        {/if}
      </div>
    </section>
  {/if}
</main>
