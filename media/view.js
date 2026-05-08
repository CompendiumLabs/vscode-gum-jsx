(function () {
    const vscode = acquireVsCodeApi();
    const stage = document.getElementById('stage');
    const errorBox = document.getElementById('error');
    const status = document.getElementById('status');

    let statusTimer = null;

    function showStatus(text) {
        status.textContent = text;
        status.classList.add('visible');
        if (statusTimer) clearTimeout(statusTimer);
        statusTimer = setTimeout(() => status.classList.remove('visible'), 600);
    }

    function showSvg(svg) {
        errorBox.hidden = true;
        errorBox.textContent = '';
        stage.innerHTML = svg;
        showStatus('Rendered');
        vscode.setState({ lastSvg: svg });
    }

    function showError(message) {
        errorBox.hidden = false;
        errorBox.textContent = message;
        showStatus('Error');
    }

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'svg') showSvg(msg.svg);
        else if (msg.type === 'error') showError(msg.message);
    });

    const prior = vscode.getState();
    if (prior && prior.lastSvg) {
        stage.innerHTML = prior.lastSvg;
    }
}());
