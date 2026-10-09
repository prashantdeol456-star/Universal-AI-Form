// Behaviour of the test form: dependent fields, a custom combobox, and a shadow-DOM widget.
(function () {
  var country = document.getElementById("country");
  var stateRow = document.getElementById("stateRow");
  var state = document.getElementById("state");
  var slot = document.getElementById("districtSlot");

  country.addEventListener("change", function () {
    stateRow.hidden = country.value !== "India";
    if (country.value !== "India") slot.innerHTML = "";
  });

  // District is created only after a state is chosen (field that did not exist on load).
  state.addEventListener("change", function () {
    slot.innerHTML = "";
    if (!state.value) return;
    var districts = { "Uttar Pradesh": ["Lucknow", "Kanpur", "Varanasi"], Bihar: ["Patna", "Gaya"], Rajasthan: ["Jaipur", "Udaipur"] }[state.value] || [];
    var row = document.createElement("div");
    row.className = "row";
    row.innerHTML = '<label for="district">District *</label><select id="district" name="district" required><option value="">Select</option>' +
      districts.map(function (d) { return "<option>" + d + "</option>"; }).join("") + "</select>";
    slot.appendChild(row);
  });

  // Minimal ARIA combobox.
  var qual = document.getElementById("qual");
  var list = document.getElementById("qualList");
  qual.addEventListener("focus", function () { list.hidden = false; qual.setAttribute("aria-expanded", "true"); });
  qual.addEventListener("blur", function () { setTimeout(function () { list.hidden = true; qual.setAttribute("aria-expanded", "false"); }, 150); });
  list.addEventListener("mousedown", function (e) {
    if (e.target && e.target.getAttribute("role") === "option") qual.value = e.target.textContent;
  });

  // Web component with an open shadow root.
  customElements.define("ufa-test-widget", class extends HTMLElement {
    constructor() {
      super();
      var root = this.attachShadow({ mode: "open" });
      root.innerHTML = '<style>label{display:block;margin:.4rem 0 .2rem}</style>' +
        '<label for="aadhaarLast4">Aadhaar Number (last 4 digits)</label><input id="aadhaarLast4" name="aadhaarLast4" maxlength="4">';
    }
  });
})();
