const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

function delay(time) {
    return new Promise(function (resolve) {
        setTimeout(resolve, time);
    });
}

// Function to get latitude and longitude using Nominatim
async function getLatLongFromAddress(address) {
    const { default: fetch } = await import('node-fetch'); // Dynamically import node-fetch
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`;

    try {
        // Fetch the geocoding data
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; MyGeocoderApp/1.0; +http://mywebsite.com)'
            }
        });
        const data = await response.json();

        if (data && data.length > 0) {
            const { lat, lon } = data[0];
            console.log(`Latitude: ${lat}, Longitude: ${lon}`);
            return { latitude: lat, longitude: lon };
        } else {
            console.log('No results found for the address.');
            return { latitude: 'N/A', longitude: 'N/A' };
        }
    } catch (error) {
        console.error('Error fetching data:', error);
        return { latitude: 'N/A', longitude: 'N/A' };
    }
}

async function scrapeAmenities(page) {
    const amenities = await page.$$eval('.amenities-list li', lis =>
        lis.map(li => li.textContent.trim())
    ).catch(() => []);
    return amenities;
}

(async () => {
    // Launch browser with Edge, headless off
    const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', // Correct the path
    headless: 'new',
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--start-maximized'
    ]
});

    const page = await browser.newPage();

    // Set user agent to avoid being blocked
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.102 Safari/537.36');

    // Set cookies
    const cookies = [
        { name: 'LS_CSRF_TOKEN', value: '4dc01f82-a229-4f09-a2f6-9ad07c286f49', domain: 'salesiq.zoho.com' },
        { name: 'PLAY_SESSION', value: 'eyJhbGciOiJIUzI1NiJ9...', domain: 'www.privateproperty.com.ng' },  // Truncated for brevity
        { name: 'privatepropertynigeria-_zldp', value: 'AYRpHo48bHn3LibD...', domain: '.privateproperty.com.ng' },  // Truncated for brevity
        { name: 'privatepropertynigeria-_zldt', value: '96d13800-a2eb-411a...', domain: '.privateproperty.com.ng' }  // Truncated for brevity
    ];

    await page.setCookie(...cookies);

    // Function to scrape data from a property URL
    async function scrapePropertyData(propertyUrl) {
        await page.goto(propertyUrl, { waitUntil: 'load', timeout: 0 });

        // Scrape the JSON-LD from <script> tag
        const jsonLd = await page.$eval('script[type="application/ld+json"]', el => el.textContent).catch(() => null);
        let addressLocality = 'N/A';

        if (jsonLd) {
            const data = JSON.parse(jsonLd);
            if (data.address && data.address.streetAddress) {
                addressLocality = data.address.streetAddress;  // Extract the locality
            }
        }

        // Scrape address
        let address = 'N/A';
        const propertyInfoDiv = await page.$('.property-info');
        if (propertyInfoDiv) {
            const pTags = await page.$$eval('.property-info p', ps => {
                const pWithSvg = ps.find(p => p.querySelector('svg'));
                return pWithSvg ? pWithSvg.textContent.trim() : 'N/A';
            });
            address = pTags || 'N/A';
        }


        // Scrape other data as usual
        const name = await page.$eval('meta[property="og:title"]', el => el.content).catch(() => 'N/A');
        const description = await page.$eval('.description-list.mb-2', el => el.textContent.trim()).catch(() => 'N/A');
        const price = await page.$eval('p.price', el => el.textContent.trim()).catch(() => 'N/A');

        const characteristics = {};
        const benefits = await page.$$eval('ul.property-benefit li', lis => lis.map(li => li.textContent.trim())).catch(() => []);
        if (benefits.length >= 3) {
            characteristics.bedrooms = benefits[0];
            characteristics.bathrooms = benefits[1];
            characteristics.additional_rooms = benefits[2];
        }

        const propertyDetails = {};
        const details = await page.$$eval('div.property-details li', lis => {
            return lis.map(li => {
                const key = li.querySelector('span') ? li.querySelector('span').textContent.trim() : '';
                const value = li.textContent.replace(key, '').trim();
                return { key, value };
            });
        }).catch(() => []);

        details.forEach(detail => {
            if (detail.key) {
                propertyDetails[detail.key] = detail.value;
            }
        });

        const propertyType = propertyDetails['Property Type'] || 'N/A';
        const transactionType = propertyUrl.toLowerCase().includes('sale') ? 'sale' : 'rent';

        const amenities = await scrapeAmenities(page);

        const area = propertyDetails['Sqm'] || '-'



        // Get latitude and longitude based on address locality using getLatLongFromAddress function
        const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(address)}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2' });
        await delay(5000); // Allow time for Google Maps to load
    
        let latitude = 'N/A', longitude = 'N/A';
        const currentUrl = page.url();
        const urlMatch = currentUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
        if (urlMatch) {
            latitude = urlMatch[1];
            longitude = urlMatch[2];
            console.log(`Latitude: ${latitude}, Longitude: ${longitude}`);
        } else {
            console.log('Google Maps could not find latitude and longitude. Falling back to Nominatim.');
            const fallbackCoordinates = await getLatLongFromAddress(address);
            latitude = fallbackCoordinates.latitude;
            longitude = fallbackCoordinates.longitude;
        }



        return {
            url: propertyUrl,
            name,
            description,
            price,
            address,
            address,
            area,
            characteristics,
            propertyDetails,
            amenities,
            propertyType,
            transactionType,
            latitude,
            longitude
        };
    }

    // Function to scrape all property URLs from the base URL
    async function scrapeBaseUrl(baseUrl) {
        await page.goto(baseUrl + '1', { waitUntil: 'load', timeout: 0 });

        // Find total listings and pages
        const totalListings = await page.$eval('div.result-blue strong', el => parseInt(el.textContent.replace(',', '').trim())).catch(() => 0);
        const totalPages = Math.ceil(totalListings / 21);

        console.log(`Total Listings for ${baseUrl}: ${totalListings}`);
        console.log(`Total Pages: ${totalPages}`);

        // Scrape property URLs
        const propertyLinks = new Set();
        const allPropertyData = [];


        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            console.log(`Scraping page ${pageNum}...`);
            await page.goto(baseUrl + pageNum, { waitUntil: 'load', timeout: 0 });
        
            const pageLinks = await page.$$eval('a[href]', anchors =>
                anchors
                    .map(anchor => anchor.href)
                    .filter(href => href.includes('/listings'))
            );
        
            pageLinks.forEach(link => propertyLinks.add(link));  // Add links to Set
            await delay(5000);
        }
        
        for (let propertyUrl of propertyLinks) {
            const propertyData = await scrapePropertyData(propertyUrl);
            console.log(propertyData);
            allPropertyData.push(propertyData);  // Now this should work
        }
    
        // Save data to Excel file
        const excelFileName = baseUrl.replace(/[^\w\s]/gi, '_') + '.xlsx';
        saveToExcel(allPropertyData, excelFileName);

        return allPropertyData;
    }

    // Function to save data to Excel
    function saveToExcel(data, fileName) {
    // Prepare data for Excel, with characteristics and propertyDetails as JSON strings
    const excelData = data.map(item => ({
        ...item,
        characteristics: JSON.stringify(item.characteristics), // Store characteristics as JSON string
        propertyDetails: JSON.stringify(item.propertyDetails), // Store propertyDetails as JSON string
        amenities: item.amenities.join(', ') || 'N/A' // Convert amenities array to a comma-separated string
    }));

    // Ensure the output directory exists
    const outputDir = path.resolve(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir);
    }

    // Save the Excel file in the output directory
    const filePath = path.join(outputDir, fileName);
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Properties');
    XLSX.writeFile(workbook, filePath);
    console.log(`Data saved to ${filePath}`);
}
    // Main function to scrape multiple URLs
    async function scrapeMultipleUrls(urlList) {
        for (let baseUrl of urlList) {
            const propertyData = await scrapeBaseUrl(baseUrl);
            console.log(`Scraped data for ${baseUrl}`, propertyData);
        }
    }

    // URLs to scrape
    const baseUrls = [
        'https://www.privateproperty.com.ng/property-for-sale?search=&auto=&ptype=&bedroom=1&min_price=&max_price=500000&button=',
        // Add more URLs as needed
    ];

    // Start scraping
    await scrapeMultipleUrls(baseUrls);

    await browser.close();
})();
